// ==UserScript==
// @name         BeOn RH - Minutos a Mais (90 dias)
// @namespace    beonrh
// @version      1.4
// @description  Mostra os minutos disponíveis por dia (últimos 90 dias, sem o dia de hoje), via erro do pedido de ausência. Com cache local e exportação CSV/XLS.
// @match        https://apps.beontech.com/RH/*
// @match        https://apps.beontech.com/rh/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const VERSION = '1.4';
    const ENDPOINT = 'https://apps.beontech.com/amigaui5rh/AmigaUI5Service.svc/executePRD';
    const NUM_DIAS = 90;
    const PAUSA_MS = 350;
    const STORAGE_KEY = 'beonrh_minutos_config';
    const CACHE_KEY = 'beonrh_minutos_cache';

    // 📍 Posição inicial do botão flutuante na página:
    const POSICAO_INICIAL = {
        top: '8px',
        right: '300px'
    };

    const DEFAULTS = {
        FirmaServ: "",
        NSAP: ""
    };

    function detetarNSAPDom() {
        const elementos = document.querySelectorAll('.sapMSLIInfo, .sapMText');
        for (const el of elementos) {
            const txt = (el.innerText || '').trim();
            if (/^100\d{5}$/.test(txt)) {
                return txt;
            }
        }
        return null;
    }

    function obterConfig() {
        const guardado = localStorage.getItem(STORAGE_KEY);
        let config = guardado ? JSON.parse(guardado) : { ...DEFAULTS };

        if (!config.NSAP) {
            const nsapDetetado = detetarNSAPDom();
            if (nsapDetetado) config.NSAP = nsapDetetado;
        }

        return config;
    }

    function guardarConfig(config) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    }

    // --- Cache de resultados por dia (evita repetir os pedidos já conhecidos) ---
    function obterCache() {
        try {
            return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
        } catch {
            return {};
        }
    }

    function guardarCache(cache) {
        localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    }

    function limparCache() {
        localStorage.removeItem(CACHE_KEY);
    }

    function pad(n) { return String(n).padStart(2, '0'); }
    function formatDate(d) {
        return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${String(d.getFullYear()).slice(-2)}`;
    }
    // Formato seguro para nomes de ficheiro (sem "/")
    function formatDateFicheiro(d) {
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }

    // Converte minutos totais para o formato hh:mm
    function minutosParaHHMM(min) {
        if (min === null || min === undefined || isNaN(min)) return '';
        const sinal = min < 0 ? '-' : '';
        const abs = Math.abs(min);
        const h = Math.floor(abs / 60);
        const m = abs % 60;
        return `${sinal}${pad(h)}:${pad(m)}`;
    }

    async function minutosDoDia(diaComp, config) {
        const corpoInterno = {
            ID: "",
            ID_AusenciaEquipa: "",
            ...config,
            DiaComp: diaComp,
            Inicio: "08:00",
            Fim: "19:00",
            TipoAusencia: "REH",
            Nome_TipoAusencia: "Recuperação de Horas",
            Motivo: "Recuperação de Horas",
            EstadoWF: "", PassoWF: "", Quem: window.login, Quando: "", Erro: "",
            Anexos: [], CCEnabled: true, TipoLanc: "0", Periodos: "0",
            Data: formatDate(new Date()), TimezoneOffset: "-60", SobrePosicao_Acao: "-1"
        };

        const payload = {
            login: window.login,
            view: "GT_AusenciaPessoal",
            funcao: "vpGT_AusenciaInsere",
            json: JSON.stringify(corpoInterno),
            token: window.loginToken,
        };

        const resp = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
            credentials: 'include',
            body: JSON.stringify(payload),
        });
        const data = await resp.json();
        const match = /MinInsuf (\d+)/.exec(data.d || '');
        if (!match) {
            const err = new Error(data.d || 'sem resposta reconhecível');
            err.rawResponse = data;
            throw err;
        }
        return parseInt(match[1], 10);
    }

    function tornarArrastavel(el, handle) {
        let offX = 0, offY = 0, arrastando = false, moveu = false;
        (handle || el).style.cursor = 'move';
        (handle || el).addEventListener('mousedown', (e) => {
            arrastando = true;
            moveu = false;
            const rect = el.getBoundingClientRect();
            offX = e.clientX - rect.left;
            offY = e.clientY - rect.top;
            e.preventDefault();
        });
        window.addEventListener('mousemove', (e) => {
            if (!arrastando) return;
            moveu = true;
            el.style.left = (e.clientX - offX) + 'px';
            el.style.top = (e.clientY - offY) + 'px';
            el.style.right = 'auto';
            el.style.bottom = 'auto';
        });
        window.addEventListener('mouseup', () => { arrastando = false; });
        return () => moveu;
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    // Distingue visualmente: erro de consulta (vermelho) vs 0 min legítimos (cinzento) vs valor normal
    function renderTabela(resultados, esconderZero) {
        let html = `
            <table style="width:100%;border-collapse:collapse;font-size:11px;">
                <thead>
                    <tr style="border-bottom:2px solid #ccc;color:#555;">
                        <th style="padding:2px 4px;font-weight:600;text-align:left;">Data</th>
                        <th style="padding:2px 4px;font-weight:600;text-align:center;">Minutos</th>
                    </tr>
                </thead>
                <tbody>`;

        for (const r of resultados) {
            if (esconderZero && r.min === 0) continue;

            let valor;
            if (r.min === null) {
                valor = `<span style="color:#c0392b;font-weight:600;cursor:help" title="${escapeHtml(r.erro || '')}">⚠ erro</span>`;
            } else if (r.min === 0) {
                valor = `<span style="color:#999;">0 min</span>`;
            } else {
                valor = `<span style="color:#111;font-weight:600;">${r.min} min</span>`;
            }

            html += `
                <tr style="border-bottom:1px solid #f0f0f0;">
                    <td style="padding:3px 4px;color:#333;text-align:left;">${r.dia}</td>
                    <td style="padding:3px 4px;text-align:center;">${valor}</td>
                </tr>`;
        }

        html += '</tbody></table>';
        return html;
    }

    // Gera um ficheiro Excel (.xls, formato SpreadsheetML) sem depender de nenhuma
    // biblioteca externa - evita problemas de CDN bloqueado pela rede da empresa.
    // A coluna hh:mm já sai formatada como hora, pronta a usar.
    function gerarXLS(linhas) {
        let xml = '<?xml version="1.0"?>\n' +
            '<?mso-application progid="Excel.Sheet"?>\n' +
            '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" ' +
            'xmlns:o="urn:schemas-microsoft-com:office:office" ' +
            'xmlns:x="urn:schemas-microsoft-com:office:excel" ' +
            'xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n' +
            ' <Styles>\n' +
            '  <Style ss:ID="Cabecalho"><Font ss:Bold="1"/></Style>\n' +
            '  <Style ss:ID="Hora"><NumberFormat ss:Format="[h]:mm"/></Style>\n' +
            ' </Styles>\n' +
            ' <Worksheet ss:Name="Minutos">\n' +
            '  <Table>\n' +
            '   <Row>\n' +
            '    <Cell ss:StyleID="Cabecalho"><Data ss:Type="String">Dia</Data></Cell>\n' +
            '    <Cell ss:StyleID="Cabecalho"><Data ss:Type="String">Minutos</Data></Cell>\n' +
            '    <Cell ss:StyleID="Cabecalho"><Data ss:Type="String">hh:mm</Data></Cell>\n' +
            '   </Row>\n';

        linhas.forEach(r => {
            xml += '   <Row>\n' +
                `    <Cell><Data ss:Type="String">${escapeHtml(r.dia)}</Data></Cell>\n`;
            if (r.min === null) {
                xml += '    <Cell><Data ss:Type="String">erro</Data></Cell>\n' +
                    '    <Cell><Data ss:Type="String"></Data></Cell>\n';
            } else {
                const serial = r.min / 1440; // fração do dia, para o Excel interpretar como hora
                xml += `    <Cell><Data ss:Type="Number">${r.min}</Data></Cell>\n` +
                    `    <Cell ss:StyleID="Hora"><Data ss:Type="Number">${serial}</Data></Cell>\n`;
            }
            xml += '   </Row>\n';
        });

        xml += '  </Table>\n' +
            ' </Worksheet>\n' +
            '</Workbook>';
        return xml;
    }

    function mostrarPainel() {
        if (document.getElementById('painel-minutos-rh')) return;

        const hoje = new Date();
        const dias = [];
        // Começa em i = 1 para NUNCA incluir o dia de hoje (valores viriam sempre errados)
        for (let i = 1; i <= NUM_DIAS; i++) {
            const d = new Date(hoje);
            d.setDate(d.getDate() - i);
            dias.push(d);
        }

        // Layout Principal
        const painel = document.createElement('div');
        painel.id = 'painel-minutos-rh';
        painel.style.cssText = 'position:fixed;top:60px;right:20px;z-index:99999;background:#fff;border:1px solid #ccc;box-shadow:0 2px 8px rgba(0,0,0,.2);width:260px;min-height:230px;max-height:85vh;display:flex;flex-direction:column;font-size:12px;font-family:sans-serif;border-radius:6px;overflow:hidden;';
        document.body.appendChild(painel);

        // Cabeçalho
        const header = document.createElement('div');
        header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:6px 8px;background:#f0f0f0;border-bottom:1px solid #ccc;user-select:none;flex-shrink:0;';
        header.innerHTML = `<div><b>Minutos validados</b> <span style="font-size:10px;color:#777;font-weight:normal">v${VERSION}</span></div>`;

        const ctrlBox = document.createElement('div');
        ctrlBox.style.cssText = 'display:flex;gap:4px;align-items:center;';

        const btnCfg = document.createElement('button');
        btnCfg.textContent = '⚙️';
        btnCfg.title = 'Configurar Firma e NSAP';
        btnCfg.style.cssText = 'border:none;background:transparent;cursor:pointer;padding:2px;';
        ctrlBox.appendChild(btnCfg);

        const btnFechar = document.createElement('button');
        btnFechar.textContent = '✕';
        btnFechar.title = 'Fechar painel';
        btnFechar.style.cssText = 'border:none;background:transparent;cursor:pointer;font-weight:bold;padding:2px;font-size:13px;color:#555;';
        ctrlBox.appendChild(btnFechar);

        header.appendChild(ctrlBox);
        painel.appendChild(header);

        const corpoFlex = document.createElement('div');
        corpoFlex.style.cssText = 'display:flex;flex-direction:column;flex:1;overflow:hidden;position:relative;';
        painel.appendChild(corpoFlex);

        // Sub-painel de Configuração (Modal Interno)
        const viewConfig = document.createElement('div');
        viewConfig.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;background:#fff;z-index:10;padding:12px;display:none;flex-direction:column;gap:8px;box-sizing:border-box;overflow-y:auto;';
        viewConfig.innerHTML = `
            <b style="border-bottom:1px solid #eee;padding-bottom:4px;">Configurações</b>
            <label style="display:flex;flex-direction:column;gap:2px;">
                Firma/Empresa (FirmaServ):
                <input type="text" id="cfg-firma" style="padding:4px;border:1px solid #ccc;border-radius:3px;box-sizing:border-box;width:100%;">
            </label>
            <label style="display:flex;flex-direction:column;gap:2px;">
                Número NSAP / Mecanográfico:
                <input type="text" id="cfg-nsap" style="padding:4px;border:1px solid #ccc;border-radius:3px;box-sizing:border-box;width:100%;">
            </label>
            <div style="display:flex;gap:6px;margin-top:auto;padding-top:8px;">
                <button id="cfg-guardar" style="flex:1;padding:6px;background:#007bff;color:#fff;border:none;border-radius:3px;cursor:pointer;font-weight:bold;">Guardar</button>
                <button id="cfg-cancelar" style="padding:6px;background:#eee;border:1px solid #ccc;border-radius:3px;cursor:pointer;">Cancelar</button>
            </div>
        `;
        corpoFlex.appendChild(viewConfig);

        // Barra de Ações
        const barraAcoes = document.createElement('div');
        barraAcoes.style.cssText = 'padding:8px;background:#fafafa;border-bottom:1px solid #eee;flex-shrink:0;display:flex;flex-direction:column;gap:6px;';
        corpoFlex.appendChild(barraAcoes);

        const btnParar = document.createElement('button');
        btnParar.textContent = '▶ Iniciar Consulta';
        btnParar.style.cssText = 'width:100%;cursor:pointer;padding:5px;font-weight:bold;';
        barraAcoes.appendChild(btnParar);

        // --- Menu de exportação: Copiar / CSV / XLSX ---
        const exportWrapper = document.createElement('div');
        exportWrapper.style.cssText = 'position:relative;width:100%;';

        const btnExportar = document.createElement('button');
        btnExportar.textContent = '⬇ Exportar ▾';
        btnExportar.style.cssText = 'width:100%;cursor:pointer;padding:4px;';
        exportWrapper.appendChild(btnExportar);

        const menuExport = document.createElement('div');
        menuExport.style.cssText = 'display:none;position:absolute;top:100%;left:0;right:0;background:#fff;border:1px solid #ccc;border-radius:4px;box-shadow:0 2px 6px rgba(0,0,0,.15);z-index:20;overflow:hidden;margin-top:2px;';

        function criarItemMenu(texto) {
            const item = document.createElement('div');
            item.textContent = texto;
            item.style.cssText = 'padding:6px 8px;cursor:pointer;font-size:11px;';
            item.onmouseenter = () => { item.style.background = '#f0f0f0'; };
            item.onmouseleave = () => { item.style.background = '#fff'; };
            menuExport.appendChild(item);
            return item;
        }

        const itemCopiar = criarItemMenu('📋 Copiar para a área de transferência');
        const itemCSV = criarItemMenu('⬇ Ficheiro CSV');
        const itemXLSX = criarItemMenu('⬇ Ficheiro Excel (.xls)');

        exportWrapper.appendChild(menuExport);
        barraAcoes.appendChild(exportWrapper);

        btnExportar.onclick = (e) => {
            e.stopPropagation();
            menuExport.style.display = menuExport.style.display === 'none' ? 'block' : 'none';
        };
        document.addEventListener('click', () => { menuExport.style.display = 'none'; });

        const filtroLabel = document.createElement('label');
        filtroLabel.style.cssText = 'display:flex;align-items:center;gap:4px;margin-top:2px;cursor:pointer;';
        const filtroCheckbox = document.createElement('input');
        filtroCheckbox.type = 'checkbox';
        filtroLabel.appendChild(filtroCheckbox);
        filtroLabel.appendChild(document.createTextNode('Ocultar dias com 0 min'));
        barraAcoes.appendChild(filtroLabel);

        // Link discreto para limpar a cache local
        const limparCacheLink = document.createElement('a');
        limparCacheLink.href = '#';
        limparCacheLink.textContent = 'limpar cache local';
        limparCacheLink.style.cssText = 'font-size:10px;color:#888;text-decoration:underline;cursor:pointer;align-self:flex-end;';
        limparCacheLink.onclick = (e) => {
            e.preventDefault();
            limparCache();
            limparCacheLink.textContent = 'cache limpa ✓';
            setTimeout(() => { limparCacheLink.textContent = 'limpar cache local'; }, 1500);
        };
        barraAcoes.appendChild(limparCacheLink);

        // Indicador de Progresso
        const progressoDiv = document.createElement('div');
        progressoDiv.style.cssText = 'font-size:10px;color:#666;text-align:center;display:none;padding-top:2px;';
        barraAcoes.appendChild(progressoDiv);

        // Tabela de Resultados
        const tabelaContainer = document.createElement('div');
        tabelaContainer.style.cssText = 'padding:8px;overflow-y:auto;flex:1;';
        corpoFlex.appendChild(tabelaContainer);

        // Rodapé com Totais
        const rodapeTotais = document.createElement('div');
        rodapeTotais.style.cssText = 'padding:6px 8px;background:#f9f9f9;border-top:1px solid #eee;font-size:11px;color:#333;flex-shrink:0;text-align:right;';
        rodapeTotais.innerHTML = 'Total: <b>0 min</b>';
        corpoFlex.appendChild(rodapeTotais);

        btnFechar.onclick = () => painel.remove();

        function abrirConfigView() {
            const cfg = obterConfig();
            viewConfig.querySelector('#cfg-firma').value = cfg.FirmaServ || '';
            viewConfig.querySelector('#cfg-nsap').value = cfg.NSAP || '';
            viewConfig.style.display = 'flex';
        }

        btnCfg.onclick = abrirConfigView;

        viewConfig.querySelector('#cfg-cancelar').onclick = () => {
            const cfg = obterConfig();
            if (!cfg.FirmaServ || !cfg.NSAP) {
                painel.remove();
            } else {
                viewConfig.style.display = 'none';
            }
        };

        viewConfig.querySelector('#cfg-guardar').onclick = () => {
            const firma = viewConfig.querySelector('#cfg-firma').value.trim();
            const nsap = viewConfig.querySelector('#cfg-nsap').value.trim();
            guardarConfig({ FirmaServ: firma, NSAP: nsap });
            viewConfig.style.display = 'none';
        };

        function atualizarTotais(resultados) {
            const totalMin = resultados.reduce((acc, curr) => acc + (curr.min || 0), 0);
            const horas = (totalMin / 60).toFixed(1);
            const diasTrab = (totalMin / 480).toFixed(1);
            rodapeTotais.innerHTML = `Total: <b>${totalMin} min</b> <span style="color:#666">(~${horas}h / ${diasTrab}d)</span>`;
        }

        filtroCheckbox.onchange = () => {
            tabelaContainer.innerHTML = renderTabela(resultados, filtroCheckbox.checked);
        };

        let resultados = [];
        let aCorrer = false;
        let pararPedido = false;

        // Aplica sempre o filtro atual ("ocultar 0 min") antes de exportar/copiar
        function linhasFiltradas() {
            const esconderZero = filtroCheckbox.checked;
            return resultados.filter(r => !(esconderZero && r.min === 0));
        }
        function linhaParaColunas(r) {
            const minTxt = r.min === null ? 'erro' : r.min;
            const hhmm = r.min === null ? '' : minutosParaHHMM(r.min);
            return [r.dia, minTxt, hhmm];
        }
        function gerarCSV(linhas) {
            return 'dia;minutos;hh:mm\n' + linhas.map(r => linhaParaColunas(r).join(';')).join('\n');
        }

        itemCopiar.onclick = () => {
            const linhas = linhasFiltradas();
            navigator.clipboard.writeText(gerarCSV(linhas));
            const textoOriginal = itemCopiar.textContent;
            itemCopiar.textContent = '✅ Copiado!';
            setTimeout(() => { itemCopiar.textContent = textoOriginal; }, 1500);
            menuExport.style.display = 'none';
        };

        itemCSV.onclick = () => {
            const linhas = linhasFiltradas();
            const csv = gerarCSV(linhas);
            const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `minutos_${formatDateFicheiro(new Date())}.csv`;
            a.click();
            URL.revokeObjectURL(url);
            menuExport.style.display = 'none';
        };

        itemXLSX.onclick = () => {
            menuExport.style.display = 'none';
            try {
                const linhas = linhasFiltradas();
                const xml = gerarXLS(linhas);
                const blob = new Blob([xml], { type: 'application/vnd.ms-excel' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `minutos_${formatDateFicheiro(new Date())}.xls`;
                a.click();
                URL.revokeObjectURL(url);
            } catch (e) {
                alert('Não foi possível gerar o ficheiro Excel: ' + e.message);
            }
        };

        async function correrBusca() {
            const cfgAtual = obterConfig();
            if (!cfgAtual.FirmaServ || !cfgAtual.NSAP) {
                abrirConfigView();
                return;
            }

            aCorrer = true;
            pararPedido = false;
            btnParar.textContent = '⏹ Parar';
            progressoDiv.style.display = 'block';

            const cache = obterCache();
            let count = 0;
            for (const d of dias) {
                if (pararPedido) break;
                count++;
                const diaStr = formatDate(d);
                progressoDiv.textContent = `A verificar: ${count} de ${NUM_DIAS} dias...`;

                if (Object.prototype.hasOwnProperty.call(cache, diaStr)) {
                    // Dia já conhecido -> não gasta pedido nem pausa
                    resultados.push({ dia: diaStr, min: cache[diaStr] });
                    tabelaContainer.innerHTML = renderTabela(resultados, filtroCheckbox.checked);
                    atualizarTotais(resultados);
                    continue;
                }

                try {
                    const min = await minutosDoDia(diaStr, cfgAtual);
                    resultados.push({ dia: diaStr, min });
                    cache[diaStr] = min;
                    guardarCache(cache);
                } catch (e) {
                    resultados.push({ dia: diaStr, min: null, erro: e.message, rawResponse: e.rawResponse });
                }
                tabelaContainer.innerHTML = renderTabela(resultados, filtroCheckbox.checked);
                atualizarTotais(resultados);
                if (pararPedido) break;
                await new Promise(r => setTimeout(r, PAUSA_MS));
            }
            aCorrer = false;
            progressoDiv.style.display = 'none';
            btnParar.textContent = pararPedido ? '🔄 Reiniciar' : '✅ Concluído (clica para reiniciar)';
        }

        btnParar.onclick = () => {
            if (aCorrer) {
                pararPedido = true;
            } else {
                resultados = [];
                tabelaContainer.innerHTML = '';
                atualizarTotais(resultados);
                correrBusca();
            }
        };

        tornarArrastavel(painel, header);

        const cfgInicial = obterConfig();
        if (!cfgInicial.FirmaServ || !cfgInicial.NSAP) {
            abrirConfigView();
        }
    }

    // Criar o Botão Flutuante com Posição Configurável
    const btn = document.createElement('button');
    btn.textContent = '⏱';
    btn.title = 'Clique: abrir/fechar painel. Arrasta para mover.';

    let estiloPosicao = '';
    for (const [prop, val] of Object.entries(POSICAO_INICIAL)) {
        estiloPosicao += `${prop}:${val};`;
    }

    btn.style.cssText = `position:fixed;z-index:99999;width:36px;height:36px;border-radius:50%;border:1px solid #ccc;background:#fff;box-shadow:0 2px 6px rgba(0,0,0,.2);cursor:pointer;font-size:16px;${estiloPosicao}`;
    document.body.appendChild(btn);

    const foiArrastado = tornarArrastavel(btn);
    btn.addEventListener('click', () => {
        if (foiArrastado()) return;
        // O botão flutuante agora funciona como toggle: abre se fechado, fecha se aberto
        const existente = document.getElementById('painel-minutos-rh');
        if (existente) {
            existente.remove();
        } else {
            mostrarPainel();
        }
    });
})();
