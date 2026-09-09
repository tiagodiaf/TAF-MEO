// ==UserScript==
// @name         BeOn RH - Minutos a Mais (90 dias)
// @namespace    beonrh
// @version      1.0
// @description  Mostra os minutos disponíveis por dia (últimos 90 dias), via erro do pedido de ausência
// @match        https://apps.beontech.com/RH/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const VERSION = '2.6';
    const ENDPOINT = 'https://apps.beontech.com/amigaui5rh/AmigaUI5Service.svc/executePRD';
    const NUM_DIAS = 90;
    const PAUSA_MS = 350;
    const STORAGE_KEY = 'beonrh_minutos_config';

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

    function pad(n) { return String(n).padStart(2, '0'); }
    function formatDate(d) {
        return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${String(d.getFullYear()).slice(-2)}`;
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
            const valor = r.min === null
                ? `<span style="color:#a00;cursor:help" title="${escapeHtml(r.erro || '')}">erro ⓘ</span>`
                : `${r.min} min`;

            html += `
                <tr style="border-bottom:1px solid #f0f0f0;">
                    <td style="padding:3px 4px;color:#333;text-align:left;">${r.dia}</td>
                    <td style="padding:3px 4px;text-align:center;font-weight:600;color:#111;">${valor}</td>
                </tr>`;
        }

        html += '</tbody></table>';
        return html;
    }

    function mostrarPainel() {
        if (document.getElementById('painel-minutos-rh')) return;

        const hoje = new Date();
        const dias = [];
        for (let i = 0; i < NUM_DIAS; i++) {
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

        const btnMin = document.createElement('button');
        btnMin.textContent = '_';
        btnMin.title = 'Minimizar / expandir';
        btnMin.style.cssText = 'border:none;background:transparent;cursor:pointer;font-weight:bold;padding:2px;';
        ctrlBox.appendChild(btnMin);

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

        const btnCopiar = document.createElement('button');
        btnCopiar.textContent = '📋 Copiar resultados';
        btnCopiar.title = 'Copia os resultados para a área de transferência';
        btnCopiar.style.cssText = 'width:100%;cursor:pointer;padding:4px;';
        barraAcoes.appendChild(btnCopiar);

        const filtroLabel = document.createElement('label');
        filtroLabel.style.cssText = 'display:flex;align-items:center;gap:4px;margin-top:2px;cursor:pointer;';
        const filtroCheckbox = document.createElement('input');
        filtroCheckbox.type = 'checkbox';
        filtroLabel.appendChild(filtroCheckbox);
        filtroLabel.appendChild(document.createTextNode('Ocultar dias com 0 min'));
        barraAcoes.appendChild(filtroLabel);

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

        let minimizado = false;
        btnMin.onclick = () => {
            minimizado = !minimizado;
            corpoFlex.style.display = minimizado ? 'none' : 'flex';
            btnMin.textContent = minimizado ? '▢' : '_';
        };

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

        btnCopiar.onclick = () => {
            const csv = resultados.map(r => `${r.dia};${r.min ?? 'erro'}`).join('\n');
            navigator.clipboard.writeText('dia;minutos\n' + csv);
            btnCopiar.textContent = '✅ Copiado!';
            setTimeout(() => { btnCopiar.textContent = '📋 Copiar resultados'; }, 1500);
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

            let count = 0;
            for (const d of dias) {
                if (pararPedido) break;
                count++;
                progressoDiv.textContent = `A consultar: ${count} de ${NUM_DIAS} dias...`;
                const diaStr = formatDate(d);
                try {
                    const min = await minutosDoDia(diaStr, cfgAtual);
                    resultados.push({ dia: diaStr, min });
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
    btn.title = 'Clique: abrir painel. Arrasta para mover.';

    let estiloPosicao = '';
    for (const [prop, val] of Object.entries(POSICAO_INICIAL)) {
        estiloPosicao += `${prop}:${val};`;
    }

    btn.style.cssText = `position:fixed;z-index:99999;width:36px;height:36px;border-radius:50%;border:1px solid #ccc;background:#fff;box-shadow:0 2px 6px rgba(0,0,0,.2);cursor:pointer;font-size:16px;${estiloPosicao}`;
    document.body.appendChild(btn);

    const foiArrastado = tornarArrastavel(btn);
    btn.addEventListener('click', () => {
        if (foiArrastado()) return;
        mostrarPainel();
    });
})();
