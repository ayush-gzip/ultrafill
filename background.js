const MODES = ['elastic', 'stretch', 'zoom', 'off'];

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'cycle-mode') return;
  const { mode } = await chrome.storage.sync.get({ mode: 'elastic' });
  await chrome.storage.sync.set({ mode: MODES[(MODES.indexOf(mode) + 1) % MODES.length] });
});
