import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";

/**
 * Classe che si occupa di monitorare quando VS Code è chiuso
 * e di sostituire il file state.vscdb con una versione temporanea
 */
export class StateDBWatcher {
    private tempFilePath: string;
    private targetFilePath: string;
    private replacerScriptPath: string;

    /**
     * Costruttore
     * @param tempFilePath Percorso del file temporaneo contenente il nuovo state.vscdb
     * @param targetFilePath Percorso del file state.vscdb da sostituire
     */
    constructor(tempFilePath: string, targetFilePath: string) {
        this.tempFilePath = tempFilePath;
        this.targetFilePath = targetFilePath;
        this.replacerScriptPath = this.createReplacerScript();
    }

    /**
     * Crea uno script che verrà eseguito quando VS Code è chiuso
     * per sostituire il file state.vscdb con la versione temporanea
     */
    private createReplacerScript(): string {
        try {
            // Crea una directory per lo script
            const scriptDir = path.join(os.homedir(), ".vscode-syncing-scripts");
            fs.ensureDirSync(scriptDir);

            // Crea un file di script univoco
            const timestamp = new Date().getTime();
            const scriptPath = path.join(scriptDir, `replace-state-${timestamp}.sh`);

            // Contenuto dello script
            let scriptContent;
            if (process.platform === "win32") {
                // Windows (batch script)
                scriptContent = `@echo off
rem Script per sostituire il file state.vscdb quando VS Code è chiuso
rem Generato automaticamente da VS Code Syncing

:wait_loop
tasklist | find /i "code.exe" > nul
if %ERRORLEVEL% == 0 (
    timeout /t 5 > nul
    goto wait_loop
)

echo VS Code non è in esecuzione. Sostituisco il file state.vscdb...

if exist "${this.targetFilePath}" (
    copy "${this.targetFilePath}" "${this.targetFilePath}.backup"
)

copy "${this.tempFilePath}" "${this.targetFilePath}"
del "${this.tempFilePath}"

echo Sostituzione completata.
del "%~f0"
`;
                // Salva come .bat
                const batPath = scriptPath.replace(".sh", ".bat");
                fs.writeFileSync(batPath, scriptContent);
                return batPath;
            } else {
                // Linux/Mac (bash script)
                scriptContent = `#!/bin/bash
# Script per sostituire il file state.vscdb quando VS Code è chiuso
# Generato automaticamente da VS Code Syncing

function is_vscode_running() {
    pgrep -f "code" > /dev/null
    return $?
}

# Aspetta che VS Code sia chiuso
while is_vscode_running; do
    sleep 5
done

echo "VS Code non è in esecuzione. Sostituisco il file state.vscdb..."

# Crea un backup del file originale
if [ -f "${this.targetFilePath}" ]; then
    cp "${this.targetFilePath}" "${this.targetFilePath}.backup"
fi

# Sostituisci il file
cp "${this.tempFilePath}" "${this.targetFilePath}"
rm "${this.tempFilePath}"

echo "Sostituzione completata."
rm "$0"
`;
                fs.writeFileSync(scriptPath, scriptContent);
                fs.chmodSync(scriptPath, 0o755); // Rendi eseguibile
                return scriptPath;
            }
        } catch (error) {
            console.error("Errore nella creazione dello script di sostituzione:", error);
            throw error;
        }
    }

    /**
     * Esegue lo script per la sostituzione del file state.vscdb quando VS Code è chiuso
     */
    public scheduleReplacementWhenClosed(): void {
        try {
            // Esegui lo script in background
            const { spawn } = require("child_process");

            if (process.platform === "win32") {
                // In Windows, usa "start" per eseguire in background
                spawn("cmd.exe", ["/c", "start", "/b", this.replacerScriptPath], {
                    detached: true,
                    stdio: "ignore"
                }).unref();
            } else {
                // In Linux/Mac, esegui direttamente
                spawn(this.replacerScriptPath, [], {
                    detached: true,
                    stdio: "ignore"
                }).unref();
            }

            console.log(`Script di sostituzione avviato: ${this.replacerScriptPath}`);
        } catch (error) {
            console.error("Errore nell'avvio dello script di sostituzione:", error);
            throw error;
        }
    }
} 