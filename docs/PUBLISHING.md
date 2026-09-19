# Release and GitHub Pages

The npm and NuGet versions are aligned at `0.1.0-alpha.1`. The root manifest defines ESM, CommonJS, declarations, browser globals and subpaths; the RCL embeds the same ESM engine under static web assets. Core source is not a generated dependency on a hosted CDN.

## Validation gates

The release workflow runs on main pushes, pull requests and manual dispatch. Only trusted main runs can publish. It performs Node/format tests, real Chromium tests, an offline clean-consumer npm tarball installation, declarations and subpath checks, multi-target RCL packing, package-restored .NET model tests, package-restored Server and WASM builds, one-megabyte interop checks, EditForm/remount checks and a GitHub Pages base-path smoke test.

Browser screenshots and test logs are uploaded even when a test fails. Tests of a writer round-tripping into its own reader are not desktop Microsoft Visio certification. See the compatibility matrix before changing version claims.

## Secrets and permissions

`NPM_TOKEN` authenticates npm publication. The npm job uses public access, the `alpha` dist-tag and GitHub OIDC provenance. `NUGET_API_KEY` authenticates NuGet publication. These jobs use `npm` and `nuget` environments so environment-level protection or secrets can be configured; repository-level secrets also work. Tests do not receive publication secrets. GitHub Pages uses the standard configure/upload/deploy actions and `pages: write` / `id-token: write` permissions.

A package is published only when its version is absent. A registry/network failure is not treated as an absent version. The tested tarballs and nupkgs are reused rather than rebuilt after the gates. npm and NuGet registries are independent, so a partial release is observable and rerunnable; no workflow can make a transaction spanning both registries atomic. Existing versions are immutable and are not overwritten. Increase the version for subsequent releases.

The public Pages artifact contains the studio plus a package-restored WebAssembly application at `/DrawingWeb/blazor/`. It is a static demonstration; database servers, authentication and credentials are not deployed to Pages.

## Source transport

The initial source transfer may use a one-time, SHA-256-verified compressed text payload because the implementation environment cannot push a local Git working tree. The `materialize` workflow verifies and expands that exact payload into ordinary tracked source files, removes the transport files and commits the result. It does not publish packages. The normal release workflow is committed/run only after that materialization; its checkout SHA identifies the actual reviewed source, not merely an archive transfer. Subsequent work uses ordinary source commits.

## Manual release

1. Update package.json, package-lock.json, the RCL version, sample/test references and release documentation together.
2. Run the complete validation workflow. Review browser screenshots and format diagnostics.
3. Permit the `npm` and `nuget` environments to publish. Check both registries and the resulting workflow logs.
4. Check the deployed studio and WASM sample through their public URLs. Do not infer successful deployment from repository settings alone.

A release workflow file and configured secrets are not evidence that publication actually succeeded. Use the Actions run, package versions and Pages deployment result as the source of truth.
