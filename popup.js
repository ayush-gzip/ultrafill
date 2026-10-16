const buttons = document.querySelectorAll('button[data-mode]');

function show(mode) {
  for (const b of buttons) b.classList.toggle('on', b.dataset.mode === mode);
}

chrome.storage.sync.get({ mode: 'elastic' }, (s) => show(s.mode));

for (const b of buttons) {
  b.addEventListener('click', () => {
    chrome.storage.sync.set({ mode: b.dataset.mode });
    show(b.dataset.mode);
  });
}

chrome.commands.getAll((commands) => {
  const cycle = commands.find((c) => c.name === 'cycle-mode');
  document.getElementById('key').textContent = cycle?.shortcut
    ? `Cycle modes: ${cycle.shortcut}`
    : 'Set a shortcut at chrome://extensions/shortcuts';
});
