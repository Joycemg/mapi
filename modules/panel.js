// modules/panel.js

const toggleBtn = document.getElementById('toggle-panel');
const panel = document.getElementById('panel');

let panelVisible = true;

toggleBtn?.addEventListener('click', () => {
    panelVisible = !panelVisible;
    panel.style.display = panelVisible ? 'block' : 'none';
    toggleBtn.textContent = panelVisible ? 'Pj' : 'pj';
});