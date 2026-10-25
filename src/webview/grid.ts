/*
Purpose: Mount the SQLite editor in the VS Code webview.
*/
import { HostClient } from './HostClient';
import { SqliteEditor } from './SqliteEditor';
const root = document.getElementById('app');
if (root) void new SqliteEditor(root, new HostClient()).start();
