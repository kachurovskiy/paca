import { h, render } from 'preact';
import { App } from './ui/app';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Terminal root is missing.');
render(h(App, {}), root);
if (import.meta.hot) import.meta.hot.dispose(() => render(null, root));
