const t = document.getElementById('t');
const s = document.getElementById('s');
chrome.storage.local.get('token').then(({ token }) => {
  if (token) s.textContent = 'A token is saved.';
});
document.getElementById('save').onclick = async () => {
  const v = t.value.trim();
  if (!/^[0-9a-f]{64}$/.test(v)) {
    s.textContent = 'Expected a 64-character hex token.';
    return;
  }
  await chrome.storage.local.set({ token: v });
  t.value = '';
  s.textContent = 'Saved.';
};
