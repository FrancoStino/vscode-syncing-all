import * as vscode from "vscode";

import { localize } from "../i18n";
import { normalize } from "./locale";
import { VSCODE_BUILTIN_ENVIRONMENTS } from "../constants";
import { VSCodeEdition } from "../types";
import type { NormalizedLocale } from "../types";

/**
 * Gets the VSCode extension by id.
 *
 * The id is `case-insensitive` by default.
 *
 */
export function getExtensionById(id: string, ignoreCase = true)
{
    if (id != null)
    {
        if (ignoreCase)
        {
            const targetId = id.toLocaleLowerCase();
            return vscode.extensions.all.find(ext => (ext.id.toLocaleLowerCase() === targetId));
        }
        return vscode.extensions.getExtension(id);
    }
    return;
}

/**
 * Gets the setting from `VSCode User Settings`.
 */
export function getVSCodeSetting<T>(section: string, key: string, defaultValue?: T): T
{
    return vscode.workspace.getConfiguration(section).get<T>(key, defaultValue as T);
}

/**
 * Gets the `editor.formatOnSave` setting from settings JSON.
 */
export function getJSONFormatOnSaveSetting(settingsJSON: any): boolean | undefined
{
    let result: boolean | undefined;
    const key = "editor.formatOnSave";
    if (settingsJSON)
    {
        result = settingsJSON["[json]"] && settingsJSON["[json]"][key];
        if (result == null)
        {
            result = settingsJSON["[jsonc]"] && settingsJSON["[jsonc]"][key];
        }

        if (result == null)
        {
            result = settingsJSON[key];
        }
    }
    return result;
}

/**
 * Gets the normalized VSCode locale.
 */
export function getNormalizedVSCodeLocale(): NormalizedLocale
{
    return normalize(getVSCodeLocale());
}

/**
 * Gets the VSCode locale string.
 */
export function getVSCodeLocale(): string | undefined
{
    try
    {
        return JSON.parse(process.env.VSCODE_NLS_CONFIG ?? "{}").locale;
    }
    catch
    {
        return;
    }
}

/**
 * Gets the edition of the current running VSCode.
 *
 * @throws {Error} Throws an error when the edition is unknown.
 */
export function getVSCodeEdition()
{
    switch (vscode.env.appName)
    {
        case "Visual Studio Code":
            return VSCodeEdition.STANDARD;

        case "Visual Studio Code - Insiders":
            return VSCodeEdition.INSIDERS;

        case "Visual Studio Code - Exploration":
            return VSCodeEdition.EXPLORATION;

        case "VSCodium":
            return VSCodeEdition.VSCODIUM;

        case "VSCodium - Insiders":
            return VSCodeEdition.VSCODIUM_INSIDERS;

        case "Code - OSS":
            return VSCodeEdition.OSS;

        case "code-server":
            return VSCodeEdition.CODESERVER;

        case "Cursor":
            return VSCodeEdition.CURSOR;

        default:
            throw new Error(localize("error.env.unknown.vscode"));
    }

    // if (vscode.extensions.getExtension("coder.coder"))
    // {
    //     return VSCodeEdition.CODER;
    // }
}

/**
 * Gets the builtin-environment of the current running VSCode.
 *
 * @throws {Error} Throws an error when the environment is not found.
 */
export function getVSCodeBuiltinEnvironment()
{
    return VSCODE_BUILTIN_ENVIRONMENTS[getVSCodeEdition()];
}

/**
 * Opens the file in a VSCode editor.
 *
 * @param filepath The full path of the file.
 */
export function openFile(filepath: string)
{
    vscode.commands.executeCommand("vscode.open", vscode.Uri.file(filepath));
}

/**
 * Closes VSCode and restarts it automatically.
 * This approach uses Node.js child_process to spawn a new instance after the current one closes.
 */
export function restartWindow()
{
    // Import Node.js modules for process management
    const { spawn } = require("child_process");
    const path = require("path");
    const fs = require("fs");

    // Show a message to confirm the user wants to restart VSCode completely
    vscode.window.showInformationMessage(
        "To apply changes, Cursor will be restarted automatically.",
        "Restart Now"
    ).then(selection =>
    {
        if (selection === "Restart Now")
        {
            // Get the current executable path
            const execPath = process.env.APPIMAGE ?? process.execPath;

            // Create a temporary restart script
            const tempDir = require("os").tmpdir();
            const scriptPath = path.join(tempDir, "restart-cursor.sh");

            // The script waits a moment and then launches the application again
            const scriptContent = `#!/bin/bash
# Wait for the application to close
sleep 1
# Start the application again
"${execPath}" &
# Remove this temporary script
rm "$0"
            `;

            // Write the script to a temporary file
            fs.writeFileSync(scriptPath, scriptContent);
            fs.chmodSync(scriptPath, "755"); // Make executable

            // Execute the script in background before quitting
            spawn("/bin/bash", [scriptPath], {
                detached: true,
                stdio: "ignore"
            }).unref();

            // Now close the app - the script will restart it
            vscode.commands.executeCommand("workbench.action.quit")
                .then(undefined, (error) =>
                {
                    console.error("Error with quit command:", error);
                    vscode.commands.executeCommand("workbench.action.closeWindow");
                });
        }
    });
}

/**
 * @deprecated Use restartWindow() instead
 * For backward compatibility.
 */
export function reloadWindow()
{
    restartWindow();
}

/**
 * Register extension command on VSCode.
 */
export function registerCommand(commandOrContext: vscode.ExtensionContext | string, commandOrCallback: string | (() => void), callback?: () => void): vscode.Disposable
{
    if (typeof commandOrContext === "string")
    {
        // Called with (command, callback)
        return vscode.commands.registerCommand(commandOrContext, commandOrCallback as () => void);
    }
    else
    {
        // Called with (context, command, callback)
        const disposable = vscode.commands.registerCommand(commandOrCallback as string, callback as () => void);
        // Add to a list of disposables which are disposed when this extension is deactivated.
        commandOrContext.subscriptions.push(disposable);
        return disposable;
    }
}
