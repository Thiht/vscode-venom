# vscode-venom

[Venom](https://github.com/ovh/venom) integration with Visual Studio Code.

![Screenshot showing Venom integration with the Testing workbench](https://raw.githubusercontent.com/Thiht/vscode-venom/master/docs/screenshot.png)

## Features

- Integration with Visual Studio Code's Testing workbench
- JSON/YAML schema for validating the test suites
- Generate assertions from JSON

## Caveats

- Only Venom > 1.0.0 is supported
- Test suites must be named as `*.venom.yml`, otherwise the extension will not be activated
- The JSON schema case is strict, so for example you have to use `bodyFile` instead if `bodyfile` in the `http` executor
