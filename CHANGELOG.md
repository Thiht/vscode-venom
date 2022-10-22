# Changelog

## 1.3.1 - 2022-10-22

- Fix crash when `.venomrc` is configured with a `verbosity` > 0 (thanks [@YoannAtOVH](https://github.com/YoannAtOVH))

## 1.3.0 - 2022-09-06

- Compatibility with Venom 1.1.0-beta.5

## 1.2.0 - 2022-09-05

- Add `ovhapi` step to the JSON schema (thanks [@YoannAtOVH](https://github.com/YoannAtOVH))

## 1.1.0 - 2022-08-21

- Add `grpc` step to the JSON schema
- Add `rabbitmq` (`subscriber` and `publisher`) step to the JSON schema
- Add changelog

## 1.0.0 - 2022-08-21

- Display Venom tests in a tree structure, following their filesystem location
- Add `sudo` and `sudopassword` properties to `ssh` step in the JSON schema
- Fix `kafka` step in the JSON schema, now `consumer` and `producer` are handled properly

## 0.0.4 - 2022-03-12

- Add JSON schema for `.venomrc` files

## 0.0.3 - 2022-03-09

- Handle test suites in `error` status, additionally to `failure` status

## 0.0.2 - 2022-03-08

- Fix issue regarding current working directory when executing tests

## 0.0.1 - 2022-03-07

- First public release
