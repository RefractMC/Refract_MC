// ni-tweaks.jsx — Tweaks for the Refract New Instance modal.
// Accent hue (drives --p; all tints derive from it via color-mix) + backdrop dim.
// Theme (dark/light) is handled by the in-modal toggle button, mirrored here.

const NI_TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "dark",
  "accent": "#8a52ff",
  "dim": 66
}/*EDITMODE-END*/;

const ACCENTS = ["#8a52ff", "#5316D4", "#4f8cff", "#1f9d8b", "#e0588a", "#e3a13a"];

function NITweaks() {
  const [t, setTweak] = useTweaks(NI_TWEAK_DEFAULTS);
  const root = document.documentElement;

  // apply accent + dim
  React.useEffect(() => {
    if (t.accent) root.style.setProperty('--p', t.accent);
    else root.style.removeProperty('--p');
    root.style.setProperty('--dim', t.dim + '%');
  }, [t.accent, t.dim]);

  // theme: keep the modal's data-theme in sync, and follow the toggle button
  React.useEffect(() => {
    root.setAttribute('data-theme', t.theme === 'light' ? 'light' : 'dark');
    try { localStorage.setItem('refract-ni-theme', t.theme); } catch (e) {}
  }, [t.theme]);

  React.useEffect(() => {
    const obs = new MutationObserver(() => {
      const cur = root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
      if (cur !== t.theme) setTweak('theme', cur);
    });
    obs.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  });

  return (
    <TweaksPanel title="Tweaks">
      <TweakSection label="Appearance" />
      <TweakRadio label="Theme" value={t.theme}
        options={['dark', 'light']}
        onChange={(v) => setTweak('theme', v)} />
      <TweakColor label="Accent" value={t.accent}
        options={ACCENTS}
        onChange={(v) => setTweak('accent', v)} />
      <TweakSection label="Backdrop" />
      <TweakSlider label="Dim" value={t.dim} min={0} max={92} unit="%"
        onChange={(v) => setTweak('dim', v)} />
    </TweaksPanel>
  );
}

(function mountNITweaks() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  ReactDOM.createRoot(host).render(<NITweaks />);
})();
