// ==UserScript==
// @name         Ajuste Campos Orcamento
// @namespace    https://github.com/tiagodiaf/TAF-MEO/
// @version      1.0
// @updateURL    https://github.com/tiagodiaf/TAF-MEO/raw/refs/heads/main/ajuste-campos-orcamento.user.js
// @downloadURL  https://github.com/tiagodiaf/TAF-MEO/raw/refs/heads/main/ajuste-campos-orcamento.user.js
// @description  Ajusta automaticamente campos de pesquisa/filtro na página de Pesquisa de Ordens de Orçamento (Nemesis)
// @author       Tiago Afonso
// @match        https://nemesis.telecom.pt/NemesisOrcamentacao/Orcamentacao.Ordens_Orcamento_Pesquisa.aspx*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // IDs dos campos a ajustar
    const SEARCH_INPUT_ID = 'wtSearchInput';
    const MAX_REC_INPUT_ID = 'wtMaterial_MaxRec';
    const NEW_MAX_REC_VALUE = '99999';

    function ajustarCampos() {
        let alterou = false;

        // 1. Remover o limite de caracteres do campo de pesquisa
        const searchInput = document.getElementById(SEARCH_INPUT_ID);
        if (searchInput && searchInput.hasAttribute('maxlength')) {
            searchInput.removeAttribute('maxlength');
            alterou = true;
        }

        // 2. Aumentar o valor máximo de registos
        const maxRecInput = document.getElementById(MAX_REC_INPUT_ID);
        if (maxRecInput && maxRecInput.value !== NEW_MAX_REC_VALUE) {
            maxRecInput.value = NEW_MAX_REC_VALUE;
            alterou = true;
        }

        return alterou;
    }

    // Corre logo que possível
    ajustarCampos();

    // Garante que corre também depois do DOM estar totalmente pronto
    document.addEventListener('DOMContentLoaded', ajustarCampos);
    window.addEventListener('load', ajustarCampos);

    // Observa alterações no DOM (útil se a secção for recarregada via AJAX/UpdatePanel
    // sem recarregar a página toda, comum em páginas ASP.NET Web Forms)
    const observer = new MutationObserver(() => {
        ajustarCampos();
    });

    observer.observe(document.documentElement, {
        childList: true,
        subtree: true
    });

})();
