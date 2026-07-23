const fill = document.getElementById('fill');
const counter = document.getElementById('counter');
const percent = document.getElementById('percent');
const extra = document.getElementById('extra');

// Renderiza o estado atual da captura no popup.
function render(state = {}) {
  const total = Number(state.totalSteps || 0);
  const current = Number(state.currentStep || 0);
  const active = Boolean(state.active);
  const message = state.message || (active ? 'Processando capturas...' : 'Pronto para iniciar.');
  const done = total > 0 ? Math.min(current, total) : 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  fill.style.width = `${pct}%`;
  counter.textContent = `${done} / ${total}`;
  percent.textContent = `${pct}%`;
  extra.textContent = message;
}

// Lê o progresso salvo pelo service worker e atualiza a interface.
function refresh() {
  chrome.storage.local.get(['printIFFarProgress'], (result) => {
    render(result.printIFFarProgress || {});
  });
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') {
    return;
  }

  if (changes.printIFFarProgress) {
    render(changes.printIFFarProgress.newValue || {});
  }
});

// Dispara a captura assim que o popup abre.
function startCapture() {
  chrome.runtime.sendMessage({ type: 'START_CAPTURE' }, (response) => {
    if (chrome.runtime.lastError) {
      extra.textContent = `Erro: ${chrome.runtime.lastError.message}`;
      return;
    }

    if (response && response.ok) {
      refresh();
      return;
    }

    if (response && response.error) {
      extra.textContent = response.error;
    }
  });
}

refresh();
startCapture();