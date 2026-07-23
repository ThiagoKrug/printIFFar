# PrintIFFar

Extensao Chrome (Manifest V3) para capturar uma pagina longa por viewport, consolidar tudo em um unico PDF e baixar automaticamente o arquivo final.

## O que este projeto faz

- Captura a pagina visivel em blocos verticais (viewport por viewport).
- Junta as capturas em uma unica pagina de PDF.
- Adiciona cabecalho no PDF com:
	- URL completa da pagina
	- Data e hora da geracao
	- CNPJ extraido da propria pagina
- Exibe progresso no popup da extensao durante a captura.
- Aplica protecoes para reduzir inconsistencias durante a rolagem (limite de chamadas, bloqueio de carregamento dinamico e restauracao do estado ao final).

## Fluxo de funcionamento

1. O usuario clica no icone da extensao.
2. O popup abre e inicia a captura automaticamente.
3. O service worker:
	 - identifica dimensoes da pagina
	 - bloqueia carregamento incremental durante a captura
	 - percorre os offsets de scroll
	 - captura cada viewport com chrome.tabs.captureVisibleTab
	 - remove sobreposicao do ultimo print, quando necessario
4. As imagens sao convertidas em um PDF unico com jsPDF.
5. O PDF e baixado como screenshot-completa.pdf.
6. O estado da pagina e restaurado (scroll, APIs e estilos temporarios).

## Estrutura principal

- background.js
	- logica principal de captura, montagem do PDF e download
- popup.html
	- interface do popup da extensao
- popup.js
	- progresso em tempo real e disparo automatico da captura
- manifest.json
	- configuracao da extensao e permissoes
- jspdf.umd.min.js
	- biblioteca para geracao do PDF

## Permissoes utilizadas

- activeTab
	- acesso a aba ativa para captura
- scripting
	- execucao de scripts na pagina para scroll, leitura de dados e ajustes temporarios
- declarativeNetRequest
	- bloqueio temporario de requests para evitar crescimento dinamico durante a captura
- storage
	- comunicacao de progresso entre background e popup
- downloads
	- download do PDF gerado
- host_permissions: <all_urls>
	- necessario para regras de rede em diferentes dominios

## Como usar

1. Abra chrome://extensions.
2. Ative Modo do desenvolvedor.
3. Carregue a pasta do projeto como extensao sem compactacao.
4. Abra a pagina alvo.
5. Clique no icone da extensao.
6. Aguarde o progresso no popup e nao troque de aba ate o fim.

## Observacoes tecnicas

- O processo usa rate limit para evitar erro MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND.
- Em paginas com elementos fixed/sticky, a extensao oculta esses elementos a partir do segundo print para evitar repeticao visual.
- O CNPJ e extraido por padroes de texto e aceita formato alfanumerico.

## Limites conhecidos

- Sites com comportamento altamente dinamico podem exigir ajustes de seletor/estrategia.
- PDF muito longo pode gerar arquivo grande, dependendo da altura total e da resolucao capturada.
