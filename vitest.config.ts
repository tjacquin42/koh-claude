import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
  resolve: {
    // `vscode` n'existe que dans l'hôte d'extensions réel : en test, résolu
    // vers un bouchon minimal (test/stubs/vscode.ts) pour que les modules qui
    // en dépendent (FocusBroker, SessionsTree) soient chargeables et testables.
    alias: { vscode: fileURLToPath(new URL('./test/stubs/vscode.ts', import.meta.url)) },
  },
});
