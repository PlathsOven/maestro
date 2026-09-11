import ReactDOM from 'react-dom/client';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/700.css';
import '@xterm/xterm/css/xterm.css';
import 'katex/dist/katex.min.css';
import './styles.css';
import App from './App';
import { useApp } from './store/app';

// Surface the otherwise-invisible class of errors — a render throw, an unhandled
// invoke() rejection — as a red toast, so they become reportable with the same
// one-click button (§10). De-duplicated (same message within 5s dropped) so a
// render loop can't flood the stack.
let lastError = '';
let lastErrorAt = 0;
function surfaceError(message: string) {
  const msg = message.trim();
  if (!msg) return;
  const now = Date.now();
  if (msg === lastError && now - lastErrorAt < 5000) return;
  lastError = msg;
  lastErrorAt = now;
  useApp.getState().toast('error', msg);
}
window.addEventListener('error', (e) => surfaceError(e.message || String(e.error ?? 'Unknown error')));
window.addEventListener('unhandledrejection', (e) => {
  const r: any = e.reason;
  surfaceError(typeof r === 'string' ? r : r?.message || 'Unhandled promise rejection');
});

ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
