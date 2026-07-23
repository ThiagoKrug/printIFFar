let jsPdfReady = false;
try {
    // Carrega a biblioteca de PDF no contexto do service worker.
    importScripts("jspdf.umd.min.js");
    jsPdfReady = Boolean(self.jspdf && self.jspdf.jsPDF);
} catch (error) {
    console.warn("Nao foi possivel carregar jsPDF:", error);
}

// Executa uma funcao dentro da aba ativa e retorna apenas o result do primeiro frame.
function executeScript(tabId, func, args = []) {
    return new Promise((resolve, reject) => {
        chrome.scripting.executeScript(
            {
                target: { tabId },
                func,
                args
            },
            (results) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }
                resolve(results && results[0] ? results[0].result : undefined);
            }
        );
    });
}

// Captura o viewport atual da aba como PNG (data URL).
function captureVisibleTab(windowId) {
    return new Promise((resolve, reject) => {
        chrome.tabs.captureVisibleTab(windowId, { format: "png" }, (dataUrl) => {
            if (chrome.runtime.lastError || !dataUrl) {
                reject(new Error(chrome.runtime.lastError?.message || "Falha ao capturar viewport."));
                return;
            }
            resolve(dataUrl);
        });
    });
}

// Baixa qualquer data URL (imagem/PDF) para o disco.
function downloadDataUrl(dataUrl, filename) {
    return new Promise((resolve, reject) => {
        chrome.downloads.download(
            {
                url: dataUrl,
                filename,
                saveAs: false
            },
            () => {
                const error = chrome.runtime.lastError;
                if (error) {
                    reject(new Error(error.message));
                    return;
                }

                resolve();
            }
        );
    });
}

function updateCaptureProgressState(state) {
    return new Promise((resolve) => {
        chrome.storage.local.set({ printIFFarProgress: state }, () => resolve());
    });
}

function clearCaptureProgressState() {
    return new Promise((resolve) => {
        chrome.storage.local.remove(["printIFFarProgress"], () => resolve());
    });
}

// Mede a dimensao real de uma imagem a partir de data URL.
async function getImageSizeFromDataUrl(dataUrl) {
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    const size = {
        width: bitmap.width,
        height: bitmap.height
    };
    bitmap.close();
    return size;
}

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("Falha ao converter blob para data URL."));
        reader.readAsDataURL(blob);
    });
}

// Quebra texto em linhas respeitando a largura maxima do PDF.
function wrapPdfTextByWidth(pdf, text, maxWidth) {
    const lines = [];
    const tokens = String(text).split(/([\/\?\&\=\-\_\.#:\s])/).filter((part) => part !== "");
    let currentLine = "";

    const pushCurrentLine = () => {
        if (currentLine.trim().length > 0) {
            lines.push(currentLine.trimEnd());
        }
        currentLine = "";
    };

    const appendToken = (token) => {
        const candidate = currentLine + token;
        if (pdf.getTextWidth(candidate) <= maxWidth) {
            currentLine = candidate;
            return;
        }

        pushCurrentLine();

        if (pdf.getTextWidth(token) <= maxWidth) {
            currentLine = token;
            return;
        }

        let chunk = "";
        for (const character of token) {
            const chunkCandidate = chunk + character;
            if (pdf.getTextWidth(chunkCandidate) <= maxWidth) {
                chunk = chunkCandidate;
            } else {
                if (chunk.length > 0) {
                    lines.push(chunk);
                }
                chunk = character;
            }
        }

        currentLine = chunk;
    };

    for (const token of tokens) {
        appendToken(token);
    }

    pushCurrentLine();
    return lines.length > 0 ? lines : [String(text)];
}

// Recorta a parte superior da imagem para remover overlap entre capturas consecutivas.
async function cropTopFromDataUrl(dataUrl, cropTopCssPx, viewportCssPx) {
    if (!cropTopCssPx || cropTopCssPx <= 0 || !viewportCssPx) {
        return dataUrl;
    }

    const response = await fetch(dataUrl);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);

    const cropRatio = Math.min(Math.max(cropTopCssPx / viewportCssPx, 0), 1);
    const cropTopImagePx = Math.round(bitmap.height * cropRatio);
    const outputHeight = bitmap.height - cropTopImagePx;

    if (outputHeight <= 1) {
        bitmap.close();
        return dataUrl;
    }

    const canvas = new OffscreenCanvas(bitmap.width, outputHeight);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(
        bitmap,
        0,
        cropTopImagePx,
        bitmap.width,
        outputHeight,
        0,
        0,
        bitmap.width,
        outputHeight
    );

    bitmap.close();
    const croppedBlob = await canvas.convertToBlob({ type: "image/png" });
    return blobToDataUrl(croppedBlob);
}

// Extrai o CNPJ do conteudo textual da pagina atual.
async function getCompanyMetadataFromPage(tabId) {
    return executeScript(tabId, () => {
        const text = (document.body && document.body.innerText) ? document.body.innerText : "";
        const normalizedText = text.replace(/\s+/g, " ");

        const findAfterLabel = (labels) => {
            for (const label of labels) {
                const patterns = [
                    new RegExp(`${label}\\s*[:\-]?\\s*([^|\\n\\r]{3,200})`, "i"),
                    new RegExp(`${label}\\s*([^|\\n\\r]{3,200})`, "i")
                ];

                for (const pattern of patterns) {
                    const match = normalizedText.match(pattern);
                    if (match && match[1]) {
                        return match[1].trim();
                    }
                }
            }

            return "";
        };

        const cnpjMatch = normalizedText.match(/CNPJ\s*[:\-]?\s*([0-9A-Z./\-]{14,30})/i);
        const cnpj = cnpjMatch ? cnpjMatch[1].trim().toUpperCase() : findAfterLabel(["CNPJ"]);

        return {
            cnpj
        };
    });
}

// Monta um PDF de pagina unica, empilhando todas as capturas verticalmente.
async function buildPdfDataUrlFromScreenshots(screenshots, metadata = {}) {
    if (!jsPdfReady) {
        throw new Error("jsPDF nao esta disponivel.");
    }

    if (!screenshots.length) {
        throw new Error("Nenhuma screenshot para converter em PDF.");
    }

    const { jsPDF } = self.jspdf;
    const imageSizes = [];
    for (let index = 0; index < screenshots.length; index += 1) {
        imageSizes.push(await getImageSizeFromDataUrl(screenshots[index]));
    }

    const pageWidth = imageSizes.reduce((max, size) => Math.max(max, size.width), 0);
    const screenshotsHeight = imageSizes.reduce((sum, size) => sum + size.height, 0);
    const headerPaddingX = 16;
    const headerFontSize = Math.max(14, Math.min(40, Math.round(pageWidth / 55)));
    const headerTopY = Math.round(headerFontSize * 1.6);
    const headerLineGap = Math.round(headerFontSize * 1.35);
    const usableHeaderWidth = Math.max(pageWidth - (headerPaddingX * 2), 1);

    const pdf = new jsPDF({
        orientation: pageWidth >= screenshotsHeight ? "l" : "p",
        unit: "px",
        format: [pageWidth, screenshotsHeight + 1],
        compress: true
    });

    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(headerFontSize);

    const siteUrl = metadata.siteUrl || "URL indisponivel";
    const generatedAt = metadata.generatedAt || "Data/hora indisponivel";
    const cnpj = metadata.cnpj || "CNPJ indisponivel";
    const wrappedUrlLines = wrapPdfTextByWidth(pdf, `URL: ${siteUrl}`, usableHeaderWidth);
    const wrappedGeneratedAtLines = wrapPdfTextByWidth(pdf, `Gerado em: ${generatedAt}`, usableHeaderWidth);
    const wrappedCnpjLines = wrapPdfTextByWidth(pdf, `CNPJ: ${cnpj}`, usableHeaderWidth);
    const headerHeight = headerTopY + (wrappedUrlLines.length * headerLineGap) + (wrappedGeneratedAtLines.length * headerLineGap) + (wrappedCnpjLines.length * headerLineGap) + 14;

    pdf.internal.pageSize.setWidth(pageWidth);
    pdf.internal.pageSize.setHeight(headerHeight + screenshotsHeight);

    pdf.text(wrappedUrlLines, headerPaddingX, headerTopY);
    pdf.text(wrappedGeneratedAtLines, headerPaddingX, headerTopY + (wrappedUrlLines.length * headerLineGap) + 8);
    pdf.text(wrappedCnpjLines, headerPaddingX, headerTopY + ((wrappedUrlLines.length + wrappedGeneratedAtLines.length) * headerLineGap) + 16);
    pdf.setDrawColor(180, 180, 180);
    pdf.line(0, headerHeight, pageWidth, headerHeight);

    let currentY = headerHeight;
    for (let index = 0; index < screenshots.length; index += 1) {
        const dataUrl = screenshots[index];
        const size = imageSizes[index];
        pdf.addImage(dataUrl, "PNG", 0, currentY, size.width, size.height, undefined, "FAST");
        currentY += size.height;
    }

    return pdf.output("datauristring");
}

async function setProgressState(active, currentStep, totalSteps, message) {
    await updateCaptureProgressState({
        active,
        currentStep,
        totalSteps,
        message
    });
}

async function runCaptureForTab(tab) {
    let startScrollY = 0;
    let pagePreparedForCapture = false;
    let pageLoadingFrozen = false;
    let tabNetworkBlocked = false;

    try {
        const pageMetrics = await executeScript(tab.id, () => {
            const doc = document.documentElement;
            return {
                totalHeight: Math.max(doc.scrollHeight, document.body ? document.body.scrollHeight : 0),
                viewportHeight: window.innerHeight,
                startScrollY: window.scrollY
            };
        });

        let totalHeight = pageMetrics.totalHeight;
        const viewportHeight = pageMetrics.viewportHeight;
        startScrollY = pageMetrics.startScrollY;

        if (!totalHeight || !viewportHeight) {
            throw new Error("Nao foi possivel obter dimensoes da pagina.");
        }

        await blockNetworkForTab(tab.id);
        tabNetworkBlocked = true;

        const lockedHeight = await freezeDynamicPageLoading(tab.id);
        pageLoadingFrozen = true;
        if (lockedHeight && Number.isFinite(lockedHeight)) {
            totalHeight = lockedHeight;
        }

        const lastStart = Math.max(totalHeight - viewportHeight, 0);
        const positions = [];
        for (let y = 0; y <= lastStart; y += viewportHeight) {
            positions.push(y);
        }

        if (positions.length === 0 || positions[positions.length - 1] !== lastStart) {
            positions.push(lastStart);
        }

        const screenshots = [];
        const siteUrl = await executeScript(tab.id, () => window.location.href);

        await setProgressState(true, 0, positions.length, "Nao troque de aba ate o processo terminar.");

        for (let index = 0; index < positions.length; index += 1) {
            const y = positions[index];

            await executeScript(tab.id, (scrollY) => {
                window.scrollTo(0, scrollY);
            }, [y]);

            if (index > 0) {
                if (!pagePreparedForCapture) {
                    await preparePageForCapture(tab.id);
                    pagePreparedForCapture = true;
                }

                await refreshHiddenFixedStickyElements(tab.id);
            }

            await sleep(250);

            let dataUrl = await captureVisibleTabWithRateLimit(tab.windowId);

            const isLastCapture = index === positions.length - 1;
            if (isLastCapture && positions.length > 1) {
                const previousY = positions[index - 1];
                const overlapCssPx = Math.max((previousY + viewportHeight) - y, 0);
                dataUrl = await cropTopFromDataUrl(dataUrl, overlapCssPx, viewportHeight);
            }

            screenshots.push(dataUrl);
            await setProgressState(true, index + 1, positions.length, "Nao troque de aba ate o processo terminar.");
        }

        const generatedAt = new Intl.DateTimeFormat("pt-BR", {
            dateStyle: "short",
            timeStyle: "medium"
        }).format(new Date());

        const companyMetadata = await getCompanyMetadataFromPage(tab.id);

        const pdfDataUrl = await buildPdfDataUrlFromScreenshots(screenshots, {
            siteUrl: siteUrl || tab.url || "URL indisponivel",
            generatedAt,
            cnpj: companyMetadata.cnpj
        });
        await downloadDataUrl(pdfDataUrl, "screenshot-completa.pdf");

        console.log(`Captura concluida: ${screenshots.length} viewport(s).`);
        return { ok: true };
    } finally {
        await clearCaptureProgressState();

        if (tabNetworkBlocked) {
            try {
                await unblockNetworkForTab(tab.id);
            } catch (unblockError) {
                console.warn("Falha ao restaurar rede da aba:", unblockError);
            }
        }

        if (pageLoadingFrozen) {
            try {
                await unfreezeDynamicPageLoading(tab.id);
            } catch (unfreezeError) {
                console.warn("Falha ao restaurar APIs bloqueadas:", unfreezeError);
            }
        }

        if (pagePreparedForCapture) {
            try {
                await restorePageAfterCapture(tab.id);
            } catch (restoreError) {
                console.warn("Falha ao restaurar elementos ocultados:", restoreError);
            }
        }

        try {
            await executeScript(tab.id, (scrollY) => {
                window.scrollTo(0, scrollY);
            }, [startScrollY]);
        } catch (scrollError) {
            console.warn("Falha ao restaurar scroll:", scrollError);
        }
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Helper para criar/remover regras de rede temporarias por sessao.
function updateSessionRules(removeRuleIds, addRules) {
    return new Promise((resolve, reject) => {
        chrome.declarativeNetRequest.updateSessionRules(
            {
                removeRuleIds,
                addRules
            },
            () => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }
                resolve();
            }
        );
    });
}

function getNetworkBlockRuleIdsForTab(tabId) {
    return [tabId + 1000000, tabId + 2000000];
}

// Bloqueia requests na aba alvo para impedir carregamento incremental durante os prints.
async function blockNetworkForTab(tabId) {
    const ruleIds = getNetworkBlockRuleIdsForTab(tabId);
    const blockRules = [
        {
            id: ruleIds[0],
            priority: 1,
            action: { type: "block" },
            condition: {
                tabIds: [tabId],
                resourceTypes: ["xmlhttprequest", "sub_frame", "script", "image", "font", "media", "object", "other"],
                regexFilter: ".*"
            }
        },
        {
            id: ruleIds[1],
            priority: 1,
            action: { type: "block" },
            condition: {
                tabIds: [tabId],
                resourceTypes: ["main_frame"],
                regexFilter: "^$"
            }
        }
    ];

    await updateSessionRules(ruleIds, blockRules);
}

async function unblockNetworkForTab(tabId) {
    const ruleIds = getNetworkBlockRuleIdsForTab(tabId);
    await updateSessionRules(ruleIds, []);
}

let lastCaptureTimestamp = 0;

async function captureVisibleTabWithRateLimit(windowId) {
    // Evita exceder o limite de capturas por segundo imposto pelo Chrome.
    const minIntervalMs = 1200;
    const elapsed = Date.now() - lastCaptureTimestamp;
    if (elapsed < minIntervalMs) {
        await sleep(minIntervalMs - elapsed);
    }

    let attempts = 0;
    while (attempts < 4) {
        attempts += 1;
        try {
            const dataUrl = await captureVisibleTab(windowId);
            lastCaptureTimestamp = Date.now();
            return dataUrl;
        } catch (error) {
            const message = String(error?.message || "");
            if (!message.includes("MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND")) {
                throw error;
            }

            const backoffMs = 1200 * attempts;
            console.warn(`Quota de captura atingida. Nova tentativa em ${backoffMs}ms...`);
            await sleep(backoffMs);
        }
    }

    throw new Error("Nao foi possivel capturar a viewport sem exceder a quota do Chrome.");
}

// Injeta CSS temporario para esconder elementos fixos/sticky e neutralizar animacoes.
async function preparePageForCapture(tabId) {
    return executeScript(tabId, () => {
        if (document.getElementById("printiffar-capture-style")) {
            return;
        }

        const style = document.createElement("style");
        style.id = "printiffar-capture-style";
        style.textContent = `
            .printiffar-hide-fixed {
                visibility: hidden !important;
                opacity: 0 !important;
                pointer-events: none !important;
            }

            * {
                animation: none !important;
                transition: none !important;
                scroll-behavior: auto !important;
                caret-color: transparent !important;
            }
        `;
        document.documentElement.appendChild(style);

        const allElements = document.querySelectorAll("*");
        allElements.forEach((el) => {
            const computed = window.getComputedStyle(el);
            if (computed.position === "fixed" || computed.position === "sticky") {
                el.classList.add("printiffar-hide-fixed");
            }
        });
    });
}

// Reaplica ocultacao de fixed/sticky para elementos que possam surgir apos o scroll.
async function refreshHiddenFixedStickyElements(tabId) {
    return executeScript(tabId, () => {
        const allElements = document.querySelectorAll("*");
        allElements.forEach((el) => {
            const computed = window.getComputedStyle(el);
            if (computed.position === "fixed" || computed.position === "sticky") {
                el.classList.add("printiffar-hide-fixed");
            }
        });
    });
}

// Remove classes/estilos temporarios aplicados durante a captura.
async function restorePageAfterCapture(tabId) {
    return executeScript(tabId, () => {
        document.querySelectorAll(".printiffar-hide-fixed").forEach((el) => {
            el.classList.remove("printiffar-hide-fixed");
        });

        const style = document.getElementById("printiffar-capture-style");
        if (style) {
            style.remove();
        }
    });
}

// "Congela" o contexto da pagina: trava altura e bloqueia APIs comuns de carregamento dinamico.
async function freezeDynamicPageLoading(tabId) {
    return executeScript(tabId, () => {
        if (window.__printIFFarFreezeState) {
            return window.__printIFFarFreezeState.lockedHeight;
        }

        const doc = document.documentElement;
        const body = document.body;
        const lockedHeight = Math.max(doc.scrollHeight, body ? body.scrollHeight : 0);

        const state = {
            lockedHeight,
            fetch: window.fetch,
            xhrOpen: XMLHttpRequest.prototype.open,
            xhrSend: XMLHttpRequest.prototype.send,
            sendBeacon: navigator.sendBeacon,
            webSocket: window.WebSocket,
            eventSource: window.EventSource,
            intersectionObserver: window.IntersectionObserver,
            resizeObserver: window.ResizeObserver,
            styleIds: []
        };

        const lockStyle = document.createElement("style");
        lockStyle.id = "printiffar-freeze-height-style";
        lockStyle.textContent = `
            html, body {
                min-height: ${lockedHeight}px !important;
            }
            body {
                overflow-anchor: none !important;
            }
        `;
        document.documentElement.appendChild(lockStyle);
        state.styleIds.push(lockStyle.id);

        window.fetch = (...args) => Promise.reject(new Error("printIFFar: fetch bloqueado durante captura"));

        XMLHttpRequest.prototype.open = function (...args) {
            this.__printIFFarBlocked = true;
            return state.xhrOpen.apply(this, args);
        };

        XMLHttpRequest.prototype.send = function (...args) {
            if (this.__printIFFarBlocked) {
                this.abort();
                return;
            }
            return state.xhrSend.apply(this, args);
        };

        navigator.sendBeacon = () => false;

        window.WebSocket = function () {
            throw new Error("printIFFar: WebSocket bloqueado durante captura");
        };

        if (window.EventSource) {
            window.EventSource = function () {
                throw new Error("printIFFar: EventSource bloqueado durante captura");
            };
        }

        if (window.IntersectionObserver) {
            window.IntersectionObserver = class {
                observe() {}
                unobserve() {}
                disconnect() {}
                takeRecords() { return []; }
            };
        }

        if (window.ResizeObserver) {
            window.ResizeObserver = class {
                observe() {}
                unobserve() {}
                disconnect() {}
            };
        }

        window.__printIFFarFreezeState = state;
        return lockedHeight;
    });
}

// Restaura todas as APIs/estilos alterados no congelamento.
async function unfreezeDynamicPageLoading(tabId) {
    return executeScript(tabId, () => {
        const state = window.__printIFFarFreezeState;
        if (!state) {
            return;
        }

        window.fetch = state.fetch;
        XMLHttpRequest.prototype.open = state.xhrOpen;
        XMLHttpRequest.prototype.send = state.xhrSend;
        navigator.sendBeacon = state.sendBeacon;
        window.WebSocket = state.webSocket;
        if (state.eventSource) {
            window.EventSource = state.eventSource;
        }
        if (state.intersectionObserver) {
            window.IntersectionObserver = state.intersectionObserver;
        }
        if (state.resizeObserver) {
            window.ResizeObserver = state.resizeObserver;
        }

        state.styleIds.forEach((id) => {
            const el = document.getElementById(id);
            if (el) {
                el.remove();
            }
        });

        delete window.__printIFFarFreezeState;
    });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== "START_CAPTURE") {
        return false;
    }

    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
        const activeTab = tabs && tabs[0];
        if (!activeTab || !activeTab.id || !activeTab.windowId) {
            sendResponse({ ok: false, error: "Nao foi possivel identificar a aba ativa." });
            return;
        }

        runCaptureForTab(activeTab)
            .then(() => sendResponse({ ok: true }))
            .catch((error) => {
                sendResponse({ ok: false, error: error?.message || "Erro durante a captura." });
            });
    });

    return true;
});



