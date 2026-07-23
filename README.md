# PrintIFFar

Extensão Chrome (Manifest V3) para capturar uma página longa por viewport, consolidar tudo em um único PDF e baixar automaticamente o arquivo final.

## O que este projeto faz

- Captura a página visível em blocos verticais (viewport por viewport).
- Junta as capturas em uma única página de PDF.
- Adiciona cabeçalho no PDF com:
	- URL completa da página
	- Data e hora da geração
	- CNPJ extraído da própria página
- Exibe progresso no popup da extensão durante a captura.
- Aplica proteções para reduzir inconsistências durante a rolagem (limite de chamadas, bloqueio de carregamento dinâmico e restauração do estado ao final).

## Fluxo de funcionamento

1. O usuário clica no ícone da extensão.
2. O popup abre e inicia a captura automaticamente.
3. O service worker:
	 - identifica dimensões da página
	 - bloqueia carregamento incremental durante a captura
	 - percorre os offsets de scroll
	 - captura cada viewport com chrome.tabs.captureVisibleTab
	 - remove sobreposição do último print, quando necessário
4. As imagens são convertidas em um PDF único com jsPDF.
5. O PDF é baixado como screenshot-completa.pdf.
6. O estado da página é restaurado (scroll, APIs e estilos temporários).

## Estrutura principal

- background.js
	- lógica principal de captura, montagem do PDF e download
- popup.html
	- interface do popup da extensão
- popup.js
	- progresso em tempo real e disparo automático da captura
- manifest.json
	- configuração da extensão e permissões
- jspdf.umd.min.js
	- biblioteca para geração do PDF

## Permissões utilizadas

- activeTab
	- acesso a aba ativa para captura
- scripting
	- execução de scripts na página para scroll, leitura de dados e ajustes temporários
- declarativeNetRequest
	- bloqueio temporário de requests para evitar crescimento dinâmico durante a captura
- storage
	- comunicação de progresso entre background e popup
- downloads
	- download do PDF gerado
- host_permissions: <all_urls>
	- necessário para regras de rede em diferentes domínios

## Como usar

1. Abra chrome://extensions.
2. Ative Modo do desenvolvedor.
3. Carregue a pasta do projeto como extensão sem compactação.
4. Abra a página alvo.
5. Clique no ícone da extensão.
6. Aguarde o progresso no popup e não troque de aba até o fim.

## Observações técnicas

- O processo usa rate limit para evitar erro MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND.
- Em páginas com elementos fixed/sticky, a extensão oculta esses elementos a partir do segundo print para evitar repetição visual.
- O CNPJ é extraído por padrões de texto e aceita formato alfanumérico.

## Limites conhecidos

- Sites com comportamento altamente dinâmico podem exigir ajustes de seletor/estratégia.
- PDF muito longo pode gerar arquivo grande, dependendo da altura total e da resolução capturada.
