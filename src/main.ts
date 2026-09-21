import { h, render } from 'preact';
import { PasswordGate } from './ui/unlock';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Terminal root is missing.');
render(h(PasswordGate, {}), root);
if (import.meta.hot) import.meta.hot.dispose(() => render(null, root));
