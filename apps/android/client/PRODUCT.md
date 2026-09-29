# Product

<!-- impeccable:product-schema 1 -->

## Platform

android

## Stack

Kotlin + Jetpack Compose + Material 3 原生用户端。验证码 WebView 为局部验证容器，不是网页套壳。Pixel gateway 是另一应用，不属于本轮 UI 修改范围。

## Product Purpose

VoDog 的 Android 原生远程通信客户端，构建和配置说明见 [Android README](../README.md)。

## Capabilities and Constraints

遵循 Material Design 和现有 Theme/Components，保留系统字体、控件、返回行为、window insets、业务与媒体逻辑。用 Android CLI/模拟器验证原生截图与交互，Web detector 不适用。
