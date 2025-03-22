import * as fs from "fs-extra";
import { Environment } from "./Environment";
import * as vscode from "vscode";

export class StateDBManager {
    private static _instance: StateDBManager;
    private _env: Environment;

    private constructor() {
        this._env = Environment.create();
        this._setupCloseHandler();
    }

    private _setupCloseHandler() {
        // Register a handler for when VSCode is about to close
        vscode.workspace.onDidCloseTextDocument(() => {
            this.applyTempStateDB();
        });
    }

    public static create(): StateDBManager {
        if (!StateDBManager._instance) {
            StateDBManager._instance = new StateDBManager();
        }
        return StateDBManager._instance;
    }

    /**
     * Applies the temporary state.vscdb file if it exists
     */
    public async applyTempStateDB(): Promise<void> {
        const stateDBPath = this._env.stateDBPath;
        const tempPath = `${stateDBPath}.temp`;

        try {
            if (fs.existsSync(tempPath)) {
                console.log("Found temporary state.vscdb file, applying it...");

                // Create a backup of the current state.vscdb if it exists
                if (fs.existsSync(stateDBPath)) {
                    const backupPath = `${stateDBPath}.backup`;
                    await fs.copy(stateDBPath, backupPath);
                    console.log(`Created backup of current state.vscdb at ${backupPath}`);
                }

                // Move the temporary file to the actual location
                await fs.move(tempPath, stateDBPath, { overwrite: true });
                console.log("Successfully applied temporary state.vscdb file");

                // Remove backup if everything succeeded
                const backupPath = `${stateDBPath}.backup`;
                if (fs.existsSync(backupPath)) {
                    await fs.remove(backupPath);
                }
            }
        } catch (error) {
            console.error("Error applying temporary state.vscdb:", error);
            // If operation fails, restore from backup if it exists
            const backupPath = `${stateDBPath}.backup`;
            if (fs.existsSync(backupPath)) {
                await fs.copy(backupPath, stateDBPath);
                await fs.remove(backupPath);
                console.log("Restored state.vscdb from backup after failed replacement");
            }
            throw error;
        }
    }

    /**
     * Merges contents from a source state.vscdb file into the current state.vscdb database
     * This allows for more granular syncing than replacing the entire file
     * @param sourceDBPath Path to the source state.vscdb file
     */
    public async mergeStateDB(sourceDBPath: string): Promise<void> {
        const targetDBPath = this._env.stateDBPath;

        // Check if both files exist
        if (!fs.existsSync(sourceDBPath)) {
            throw new Error(`Source database ${sourceDBPath} does not exist`);
        }

        // If target doesn't exist, we can just copy the source directly
        if (!fs.existsSync(targetDBPath)) {
            await fs.copy(sourceDBPath, targetDBPath);
            console.log(`Target database didn't exist, copied source directly to ${targetDBPath}`);
            return;
        }

        // Create a temporary file that will be used on close
        const tempPath = `${targetDBPath}.temp`;
        await fs.copy(sourceDBPath, tempPath);
        console.log(`Created temp file for state.vscdb at ${tempPath}`);
    }
} 