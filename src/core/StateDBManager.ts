import * as fs from "fs-extra";
import { Environment } from "./Environment";

export class StateDBManager {
    private static _instance: StateDBManager;
    private _env: Environment;

    private constructor() {
        this._env = Environment.create();
    }

    public static create(): StateDBManager {
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

        // Fallback to file replacement instead of SQLite direct manipulation
        // This avoids issues with SQLite module loading in certain environments
        console.log("Using file replacement instead of direct SQLite manipulation for safety");
        const tempPath = `${targetDBPath}.temp`;
        await fs.copy(sourceDBPath, tempPath);
        console.log(`Created temp file for fallback mode at ${tempPath}`);
        return;

        // The code below is commented out due to SQLite import issues in production builds
        /*
        // Try to import sqlite3
        let sqlite3;
        try {
            sqlite3 = require("sqlite3");
        } catch (e) {
            console.error("SQLite module not available, falling back to file replacement");
            // Create a temporary file that will be used on restart
            const tempPath = `${targetDBPath}.temp`;
            await fs.copy(sourceDBPath, tempPath);
            console.log(`Created temp file for fallback mode at ${tempPath}`);
            return;
        }

        // Create backup before any operation
        const backupPath = `${targetDBPath}.backup`;
        await fs.copy(targetDBPath, backupPath);
        console.log(`Created backup of current state.vscdb at ${backupPath}`);

        try {
            // Open both databases
            const sourceDB = new sqlite3.Database(sourceDBPath, sqlite3.OPEN_READONLY);
            const targetDB = new sqlite3.Database(targetDBPath, sqlite3.OPEN_READWRITE);

            // Begin transaction on target DB
            await new Promise<void>((resolve, reject) => {
                targetDB.run("BEGIN TRANSACTION", (err: any) => {
                    if (err) reject(err);
                    else resolve();
                });
            });

            // Get all records from source
            const sourceRecords = await new Promise<any[]>((resolve, reject) => {
                sourceDB.all("SELECT key, value FROM ItemTable", (err: any, rows: any[]) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                });
            });

            console.log(`Found ${sourceRecords.length} records in source database`);

            // Merge each record into target
            for (const record of sourceRecords) {
                await new Promise<void>((resolve, reject) => {
                    targetDB.run(
                        "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)",
                        [record.key, record.value],
                        (err: any) => {
                            if (err) reject(err);
                            else resolve();
                        }
                    );
                });
            }

            // Commit transaction
            await new Promise<void>((resolve, reject) => {
                targetDB.run("COMMIT", (err: any) => {
                    if (err) reject(err);
                    else resolve();
                });
            });

            // Close both databases
            await Promise.all([
                new Promise<void>((resolve, reject) => {
                    sourceDB.close((err: any) => {
                        if (err) reject(err);
                        else resolve();
                    });
                }),
                new Promise<void>((resolve, reject) => {
                    targetDB.close((err: any) => {
                        if (err) reject(err);
                        else resolve();
                    });
                })
            ]);

            console.log(`Successfully merged database content from ${sourceDBPath} to ${targetDBPath}`);

            // Remove backup if everything succeeded
            if (fs.existsSync(backupPath)) {
                await fs.remove(backupPath);
            }
        } catch (error) {
            console.error("Error merging state.vscdb:", error);

            // Restore from backup if it exists
            if (fs.existsSync(backupPath)) {
                await fs.copy(backupPath, targetDBPath);
                await fs.remove(backupPath);
                console.log("Restored state.vscdb from backup after failed merge");
            }

            throw error;
        }
        */
    }
} 