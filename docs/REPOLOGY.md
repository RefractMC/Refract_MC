# Repology tracking

The existing AUR identity is `refract-launcher-bin`; its PKGBUILD provides the
unversioned name `refract-launcher`. This repository audit did not find a
verified Repology project page or slug for Refract, so no live badge is added to
the README. A dead badge would be worse than a pending status.

After the first upstream package submissions are accepted, search Repology for
`refract-launcher-bin`, `refract`, and `refract-launcher`. If Repology creates
more than one project, request a normalization rule that groups the Homebrew,
Scoop, Chocolatey, nixpkgs, and AUR records under the same upstream project.
Keep the AUR package name unchanged so existing Arch users do not lose their
upgrade path.

When a project slug is confirmed, add this badge to the README using the actual
slug (replace `PROJECT_NAME` only after verification):

```html
<a href="https://repology.org/project/PROJECT_NAME/versions">
  <img
    src="https://repology.org/badge/vertical-allrepos/PROJECT_NAME.svg?exclude_unsupported=1"
    alt="Packaging status" />
</a>
```
