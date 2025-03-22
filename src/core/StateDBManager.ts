import * as fs from "fs-extra";
import { Environment } from "./Environment";

export class StateDBManager {
    private static _instance: StateDBManager;
    private _env: Environment;

    private constructor() {
        this._env = Environment.create();
    }

    public static getInstance(): StateDBManager {
        if (!StateDBManager._instance) {
            StateDBManager._instance = new StateDBManager();
        }
        return StateDBManager._instance;
    }

    /**
     * Checks if there's a temporary state.vscdb file and applies it if found
     */
    public async checkAndApplyTempStateDB(): Promise<void> {
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
} 