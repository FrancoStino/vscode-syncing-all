# Syncing

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![License: 996ICU](https://img.shields.io/badge/License-Anti%20996-blue.svg)](https://github.com/996icu/996.ICU/blob/master/LICENSE)

[English](README.md) | [中文](README.zh-CN.md)

**Syncing** *([View Source Code](https://github.com/nonoroazoro/vscode-syncing))* is a VSCode extension, designed to **synchronize all of your VSCode settings across multiple devices** with your [Google Drive](https://drive.google.com).

[Getting started](#getting-started) or [check out the examples](#examples).

> *Keep it simple & reliable!*


## Features

*Syncing* will `keep the consistency of your VSCode settings between your devices`, it'll let you:

1. **Upload VSCode Settings**:

    * Including your `User Settings`, `Keybindings`, `Extensions`, `Locales` and `Snippets`.
    * The `keybindings` of `MacOS` and `non-MacOS` will be synchronized separately, in case you have multiple devices of different operating systems.
    * Automatically create a new folder in Google Drive to store your settings.
    * Use an incremental algorithm to boost the synchronization.
    * You can `exclude some VSCode User Settings and Extensions` from being uploaded, [check out the VSCode User Settings](#vscode-user-settings) for more details.

1. **Download VSCode Settings**:

    * **Always overwrite** local settings.
    * Automatically `install, update` and `remove` extensions.
    * You can download settings from `a shared Google Drive folder`, such as your friend's VSCode settings, [check out here](#getting-started) for more details.
    * You can `exclude some VSCode User Settings and Extensions` from being downloaded, [check out the VSCode User Settings](#vscode-user-settings) for more details.

Besides, you can [set up a proxy](#proxy-settings) to accelerate the synchronization. And of course, you can turn on the [auto-sync](#auto-sync-settings) to simplify the synchronization :).


## Commands

You can type `"upload"`, `"download"` (or `"syncing"`) in `VSCode Command Palette` to access these commands:

1. ***`Syncing: Upload Settings`***

    > Upload settings to Google Drive.

1. ***`Syncing: Download Settings`***

    > Download settings from Google Drive.

1. ***`Syncing: Open Syncing Settings`***

    > Set your `Google Drive Credentials`, `Folder ID` or `HTTP Proxy` settings.


## Keybindings

The keybindings **are unassigned by default**, but you can easily turn them on by updating `VSCode Keyboard Shortcuts`:

1. For VSCode versions >= 1.11 (***recommended***):

    ![keyboard shortcuts](docs/gif/Keyboard-Shortcuts.gif)

1. For VSCode versions < 1.11, for example:

    ```json
    {
        "key": "alt+cmd+u",
        "command": "syncing.uploadSettings"
    },
    {
        "key": "alt+cmd+d",
        "command": "syncing.downloadSettings"
    },
    {
        "key": "alt+cmd+s",
        "command": "syncing.openSettings"
    }
    ```


## VSCode User Settings

You can find the following `Syncing Settings` in your `VSCode User Settings`.

1. ***`syncing.excludedExtensions`***

    You can configure [glob patterns](https://github.com/isaacs/minimatch) for excluding some `VSCode Extensions` from being synchronized.

    > Note that the extensions not listed here will still be synchronized.

    Take this for example:

    ```json
    "syncing.excludedExtensions" : [
        "somepublisher.*",
        "nonoroazoro.syncing"
    ]
    ```

    Note that the excluded `extension name` is actually the `extension id` (you can find it in the `VSCode Extensions View`), such as:

    ![exclude extensions](docs/png/Exclude-Extensions.png)

    Now the extension `nonoroazoro.syncing` (i.e., `Syncing`) and all the extensions of the author `somepublisher` will no longer be synchronized.

1. ***`syncing.excludedSettings`***

    You can configure [glob patterns](https://github.com/isaacs/minimatch) for excluding some `VSCode User Settings` from being synchronized.

    > Note that the settings not listed here will still be synchronized.

    Take this for example:

    ```json
    "syncing.excludedSettings" : [
        "editor.*",
        "workbench.colorTheme"
    ]
    ```

    Now the `workbench.colorTheme` setting and all the settings of `editor` will no longer be synchronized.

1. ***`syncing.extensions.autoUpdate`***

    You can configure this setting to let `Syncing` automatically update your extensions during the synchronization.

    This is `enabled by default` but you can turn it off in your `VSCode User Settings`.

1. ***`syncing.pokaYokeThreshold`***

    During the synchronization, `Syncing` will check the changes between your local and remote settings, and display a `confirm dialog` if the changes exceed this threshold.

    The `default value` of this setting is `10`, and you can `disable this feature` by setting to a number `less than or equal to zero` (`<= 0`).

    Take this for example:

    ```json
    "syncing.pokaYokeThreshold" : 10
    ```

1. ***`syncing.separateKeybindings`***

    Synchronize the `keybindings` separately for different operating systems.

    You may disable it since `VSCode` has introduced the [Platform Specific Keybindings](https://code.visualstudio.com/updates/v1_27#_platform-specific-keybindings) from `version 1.27`. But please make sure you've already `merged your keybindings` before disabling this setting.

    This is `enabled by default` but you can turn it off in your `VSCode User Settings`.


## Proxy Settings

You can set up a proxy to accelerate the synchronization. Here are the steps:

1. Type `"Syncing: Open Syncing Settings"` (or just `"opensync"`) in `VSCode Command Palette` to open `Syncing`'s own settings file (i.e. `syncing.json`).

1. Change the `"http_proxy"` setting, for example:

    ```json
    "http_proxy": "http://127.0.0.1:1080"
    ```

Moreover, if the `"http_proxy"` is unset, `Syncing` will try to read the `http_proxy` and `https_proxy` environment variables as a fallback.

> Please note that unlike the settings in [VSCode User Settings](#vscode-user-settings), `Syncing` **will not upload** its own settings file because it contains your personal information.


## Auto-sync Settings

You can now let Syncing auto-sync your settings. Here are the steps:

1. Type `"Syncing: Open Syncing Settings"` (or just `"opensync"`) in `VSCode Command Palette` to open `Syncing`'s own settings file (i.e. `syncing.json`).

1. Enable the `"auto_sync"` setting, for example:

    ```json
    "auto_sync": true
    ```

1. Reload or reopen VSCode to take effect.


## Storage Providers

Syncing supports multiple storage providers for synchronizing your VSCode settings:

### Google Drive

This is the default storage provider, which synchronizes your settings using Google Drive.

### Google Drive

As an alternative, you can use Google Drive to store your settings. To set up Google Drive:

1. Create a Google Cloud project and enable the Google Drive API
2. Create OAuth credentials (Web application type)
3. Type `"Syncing: Open Syncing Settings"` in VSCode Command Palette to open `Syncing`'s settings file
4. Configure Google Drive as follows:

```json
{
    "storage_provider": "google_drive",
    "google_client_id": "YOUR_CLIENT_ID",
    "google_client_secret": "YOUR_CLIENT_SECRET",
    "google_refresh_token": "YOUR_REFRESH_TOKEN",
    "auto_sync": true
}
```

To obtain a refresh token, you'll need to:
1. Use your client ID to generate an authorization URL
2. Open the URL in a browser and authorize the application
3. Copy the authorization code and exchange it for a refresh token

## Getting Started

1. Get your own `Google Drive Credentials` (3 steps).

    1. Give your account appropriate permissions, and authorize the app to use Google Drive.

    1. Select or enter your `Folder ID`.

        > You can `leave it blank` to create a new `Folder` automatically.

    1. **`Copy`** and **`backup`** your credentials.

        ![copy and backup token](docs/png/Copy-Token.png)

1. Sync your VSCode settings.

    *`Syncing`* will ask for necessary information `for the first time` and `save for later use`.

    1. **Upload**

        1. Type `upload` in `VSCode Command Palette`.

            ![upload settings](docs/png/Upload-Settings.png)

        1. Enter your `Google Drive Credentials`.

        1. Select or enter your `Folder ID`.

            > You can `leave it blank` to create a new `Folder` automatically.

        1. Done!

        1. *After it's done, you can find the settings and the corresponding `Folder ID` in your [Google Drive](https://drive.google.com). Also, you can `share the folder` to share your settings with others.*

    1. **Download**

        1. Type `download` in `VSCode Command Palette`.

            ![download settings](docs/png/Download-Settings.png)

        1. Enter your `Google Drive Credentials`.

            > You can `leave it blank` if you want to download from a `shared folder`, such as your friend's VSCode settings.

        1. Select or enter your `Folder ID` or a `shared Folder ID`.

        1. Done!


## Examples

1. Upload:

    ![upload example](docs/gif/Example-Upload.gif)

1. Download:

    ![download example](docs/gif/Example-Download.gif)

## Frequently Asked Questions

1. How do I make this work with [code-server](https://github.com/coder/code-server)?

    Code-server follows the XDG spec to set config & data directories. When using their [Docker image](https://hub.docker.com/r/codercom/code-server), you can set `XDG_DATA_HOME="/home/coder/.config/"` to store everything files in the same directory. This enables vscode-syncing to easily pickup the right locations. Since it is also a recommended volume path, it ensures persistence of your changes.
