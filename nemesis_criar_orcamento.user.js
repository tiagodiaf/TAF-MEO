// ==UserScript==
// @name         Nemesis - Criar Orçamento automático
// @namespace    nemesis.orcamentos
// @version      1.0
// @description  Cria o orçamento (com confirmação) se não existir e avança para as Recolhas, sem tempos fixos
// @match        https://nemesis.telecom.pt/Nemesis_Orc_Screens/*Orcamentos_List.aspx*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  const PEDIR_CONFIRMACAO = true; // pôr a false quando estiver a funcionar bem
  const DESCRICAO = 'Orçamento';

  const log = (...a) => console.log('[Nemesis]', ...a);
  const visivel = el => !!el && el.offsetParent !== null;

  const ordemId = new URLSearchParams(location.search).get('OrdemId') || 'x';
  const FLAG = 'nemesis_orc_criado_' + ordemId;

  // Espera até a condição devolver algo "verdadeiro" (sem atrasos fixos)
  function waitFor(cond, timeout = 30000, passo = 50) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      (function check() {
        let r = null;
        try { r = cond(); } catch (e) {}
        if (r) return resolve(r);
        if (Date.now() - t0 > timeout) return reject(new Error('timeout'));
        setTimeout(check, passo);
      })();
    });
  }

  const linhasDados = () => {
    const tabela = document.getElementById('wtOrcamentos_TR');
    if (!tabela) return [];
    return [...tabela.querySelectorAll('tr')].filter(tr =>
      tr.querySelector('td') && !tr.querySelector('th') &&
      !/Sem or[çc]amentos/i.test(tr.textContent)
    );
  };

  const tabelaPronta = () => {
    const tabela = document.getElementById('wtOrcamentos_TR');
    const botao = document.getElementById('wtaddOrcamento');
    const loading = document.getElementById('RichWidgets_wt130_block_wtdivLoading');
    return visivel(tabela) && visivel(botao) && !loading;
  };

  // Devolve {doc, campo, gravar} quando o popup estiver completamente carregado
  function getPopup() {
    for (const f of document.querySelectorAll('iframe')) {
      try {
        const d = f.contentDocument || f.contentWindow.document;
        const campo = d && d.getElementById('wtORCAMENTO_Descricao');
        const gravar = d && d.getElementById('wt11');
        if (campo && gravar) return { doc: d, campo, gravar };
      } catch (e) {}
    }
    return null;
  }

  function irParaRecolhas() {
    const link = document.getElementById('wt338');
    if (!link) { log('Link das Recolhas não encontrado.'); return; }
    log('A ir para as Recolhas...');
    location.href = link.href;
  }

  async function main() {
    log('Script iniciado');
    await waitFor(tabelaPronta, 60000);

    const existentes = linhasDados().length;
    log('Orçamentos existentes:', existentes);

    // Caso a página tenha recarregado depois de gravar
    if (existentes > 0 && sessionStorage.getItem(FLAG)) {
      sessionStorage.removeItem(FLAG);
      return irParaRecolhas();
    }

    if (existentes > 0) { log('Já existe orçamento. Nada a fazer.'); return; }

    if (PEDIR_CONFIRMACAO && !confirm('Esta ordem não tem orçamentos.\nQueres criar o orçamento automaticamente?')) {
      log('Cancelado pelo utilizador.');
      return;
    }

    // Criar
    log('A criar orçamento...');
    sessionStorage.setItem(FLAG, '1');
    document.getElementById('wtaddOrcamento').click();

    const popup = await waitFor(getPopup, 30000);
    log('Popup pronto.');
    popup.campo.value = DESCRICAO;
    popup.campo.dispatchEvent(new Event('input', { bubbles: true }));
    popup.campo.dispatchEvent(new Event('change', { bubbles: true }));
    popup.gravar.click();
    log('Gravar clicado.');

    // Espera o orçamento aparecer na lista (a página pode atualizar por AJAX)
    await waitFor(() => linhasDados().length > 0, 30000);
    log('Orçamento criado.');
    sessionStorage.removeItem(FLAG);
    irParaRecolhas();
  }

  main().catch(e => {
    sessionStorage.removeItem(FLAG);
    log('Parou:', e.message);
  });
})();
