import { render } from 'preact';
import { DeviceApproval } from './components/DeviceApproval.js';
import { Toast } from './components/Toast.js';
import { getTheme, applyTheme } from './util/theme.js';
applyTheme(getTheme());
const root = document.getElementById('app');
if (root) render(<main class="device-page-content"><h1>MyNotes — device login</h1><DeviceApproval closeWhenDone /><Toast /></main>, root);
