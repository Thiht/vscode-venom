# vscode-venom

[![Visual Studio Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/thiht.vscode-venom?color=0078d7&label=VS%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=thiht.vscode-venom)
[![Open VSX Version](https://img.shields.io/open-vsx/v/thiht/vscode-venom?color=%23c160ef&label=Open%20VSX)](https://open-vsx.org/extension/thiht/vscode-venom)

[Venom](https://github.com/ovh/venom) integration with Visual Studio Code.

![Screenshot showing Venom integration with the Testing workbench](https://raw.githubusercontent.com/Thiht/vscode-venom/master/docs/screenshot.png)

## Features

- Integration with Visual Studio Code's Testing workbench
- JSON/YAML schema for autocompleting and validating the test suites

![Screencast showing off Venom test suites autocomplete and validation](./docs/json-schema.gif)

- Generate assertions from JSON

![Screencast showing off Venom assertions generation from a JSON](./docs/generate-assertions.gif)

## Caveats

- Only Venom > 1.0.0 is supported
- Test suites must be named as `*.venom.yml`, otherwise the extension will not be activated
- The JSON schema case is strict, so for example you have to use `bodyFile` instead if `bodyfile` in the `http` executor
