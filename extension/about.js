import { localizeDocument } from './i18n.js';
localizeDocument();
const manifest = chrome.runtime.getManifest();
document.getElementById('version').textContent = manifest.version_name || manifest.version;
