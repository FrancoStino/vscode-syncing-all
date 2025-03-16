// This file exists only for backward compatibility with existing code
// All functionality is now implemented in RemoteStorage.ts and GoogleDrive.ts
// The app now uses Google Drive instead of GitHub Gist for storage

import { RemoteStorage } from "./RemoteStorage";

// Export the RemoteStorage class as Gist for backward compatibility
export { RemoteStorage as Gist };
