DEVELOPER-EDITED APPEARANCE CONFIGURATION
======================================

Edit this file only:
  ecommerce-backend/src/config/appearance/themes.json

No appearance-settings screen, theme editor, write API, layout selector or theme
database table is used. Theme files are developer-owned application configuration.
Existing admin light/dark switching remains a personal preference, not a colour/font
editor. Customer storefront mode is chosen by configuration, without a new selector.

CONFIGURATION PRECEDENCE
Admin/vendor: defaults.admin -> tenants[TENANT_UUID].admin
Storefront: defaults.storefront -> tenants[TENANT_UUID].storefront
            -> tenants[TENANT_UUID].stores[STORE_UUID].storefront
Platform/login: defaults.admin only; it never inherits an active tenant's theme.

Use lower-case tenant and store UUIDs from the relevant environment, NOT names or
store codes. labels are developer-readable descriptions only. A store override is
looked up inside its own tenant. Empty/missing override objects inherit defaults.
The supplied Hornbook Retail and MAIN entries are empty so defaults stay in use.

QUICK START: HORNBOOK ADMIN
Inside the existing Hornbook tenant entry, replace its empty admin object with:

  "admin": {
    "typography": {
      "bodyFont": "dmSans",
      "headingFont": "manrope",
      "fontSize": 16,
      "lineHeight": 1.6
    },
    "colors": { "light": { "primary": "#6d28d9" } },
    "effects": { "cornerScale": 1.1, "shadow": "soft" }
  }

QUICK START: ONE STOREFRONT ONLY
Inside that tenant's stores[STORE_UUID] entry, use:

  "storefront": {
    "mode": "light",
    "typography": { "bodyFont": "manrope", "fontSize": 16 },
    "colors": {
      "light": {
        "primary": "#164e63",
        "header": "#0f172a",
        "headerText": "#ffffff"
      }
    }
  }

These examples replace override objects, not the entire themes.json document.
Remove an override value to return to its inherited setting. Do not remove complete
defaults: they must define every base palette and required typography/effect value.

OPTIONS
mode: light | dark | system. Storefront system mode follows the OS using CSS media
queries, without selecting a different store or waiting for a theme-editor request.

typography:
  bodyFont, headingFont: manrope | dmSans | system
  fontSize: 14..20 pixels. Existing CSS sizes scale by fontSize/14, retaining their
    relative hierarchy. 14 preserves original sizes; 16 is a readable starting point.
  fontStyle: normal | italic (body style)
  lineHeight: 1.3..2 (body line spacing; component-specific ratios remain intentional)
  bodyWeight: optional 400 | 500 | 600 | 700 (default400)
  headingWeight: optional 400 | 500 | 600 | 700 | 800. If omitted, existing heading
    weights remain in place. Controls/strong emphasis keep their specific roles.

effects:
  cornerScale: 0..2, default1. Scales CSS pixel corner radii; percentage circles remain.
  shadow: existing | none | soft | medium. Controls shared glass-panel shadow tokens,
    not shadows painted inside images, SVG artwork or custom 3D scene materials.

colors.light and colors.dark accept partial objects. Every value must be #RRGGBB:
  primary, primaryHover: shared brand/accent and brand-accent controls
  button, buttonHover: main action buttons; text automatically becomes black or white
  background, surface, text, muted, border, soft
  header, headerText
  sidebar, sidebarText, sidebarMuted, sidebarActive, sidebarActiveText

Changing primary automatically derives button, hover, soft and selected-sidebar
colours in the same layer, unless those values are explicitly supplied there.
When button is intentionally different from primary, main CTAs use button while
brand-accent controls continue to use primary; each has its own readable text colour.
Sidebar fields affect admin/vendor chrome. Status/danger/warning icons keep their
meaning. Authored product photos, logos, artwork and media are not recoloured.

CONFIGURATION SAFETY
- Unknown keys, invalid IDs/colours, font URLs, arbitrary CSS and out-of-range sizes
  are rejected. Fonts come only from the bundled Manrope/DM Sans or system families.
- Resolved text/background, muted/surface, primary/background, header and sidebar
  text pairs must reach4.5:1 contrast; hover text contrast is also checked.
- All scopes are validated at API startup, including inherited store settings.
  A bad configuration fails startup clearly rather than silently applying bad CSS.
- Palette values are compiled from fixed selectors, hex values, bounded numbers and
  allowlisted font families. Never paste user CSS/HTML or secrets into this file.

APPLY A CHANGE
1. Edit themes.json and review the diff.
2. From ecommerce-backend run: node src/config/appearance/validate.js
   This validates configuration only; it does not access the database or run tests.
3. Restart the API. themes.json is loaded at startup; do not assume a JSON-only edit
   is watched by node --watch. Use your process manager/rolling restart in production.
4. Reload the admin/storefront. Admin refresh/login returns the new theme for permitted
   contexts; storefront server rendering reads the current store configuration.
5. Inspect html data-appearance-revision if checking whether the new revision arrived.
   If a local admin mode was previously chosen, it overrides the configured mode.
   Its key is commerce-theme:TENANT_UUID (or commerce-theme:platform); old commerce-theme
   is a migration fallback. Only mode is saved locally, not tenant CSS or API data.

Colour/font/size edits using supported options need only an API restart and reload,
not a new UI settings page or frontend rebuild. Adding an entirely new font family
requires bundling its font assets and extending the allowlist/mapping in both apps.

API DELIVERY AND ISOLATION
GET /api/admin/v1/appearance returns platform defaults only, ignoring tenant query
selectors. Authentication responses put permitted tenant themes in user.ui.appearance.
Admin switches styles only from its authenticated tenant context and resets on logout.
Storefront /config returns only the resolved current store's appearance, after normal
tenant/store checks. The frontend proxy's server configuration still fixes the store.
No response exposes the full tenant/store configuration registry or grants access.

IMPLEMENTATION NOTES
Most legacy CSS absolute font sizes and pixel corner radii now reference shared
variables, including component styles for forms, tables and dialogs. New styles should
use --theme-text-scale and --theme-radius-scale, or inherit existing themed typography.
This is styling only: no sidebar/page rearrangement, navigation/permission changes,
product/order updates, SaaS billing, Docker, Redis or database migration.

Verification details: docs/implementation/config-file-theming-20261102.txt
