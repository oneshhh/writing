---
name: Editorial Focus
colors:
  surface: '#fcf9f8'
  surface-dim: '#dcd9d9'
  surface-bright: '#fcf9f8'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f6f3f2'
  surface-container: '#f0eded'
  surface-container-high: '#eae7e7'
  surface-container-highest: '#e5e2e1'
  on-surface: '#1c1b1b'
  on-surface-variant: '#414845'
  inverse-surface: '#313030'
  inverse-on-surface: '#f3f0ef'
  outline: '#727975'
  outline-variant: '#c1c8c3'
  surface-tint: '#476459'
  primary: '#00150e'
  on-primary: '#ffffff'
  primary-container: '#0d2b22'
  on-primary-container: '#759487'
  inverse-primary: '#adcec0'
  secondary: '#5c5f60'
  on-secondary: '#ffffff'
  secondary-container: '#e1e3e4'
  on-secondary-container: '#626566'
  tertiary: '#0e1214'
  on-tertiary: '#ffffff'
  tertiary-container: '#232729'
  on-tertiary-container: '#8a8e91'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#c9eadc'
  primary-fixed-dim: '#adcec0'
  on-primary-fixed: '#022018'
  on-primary-fixed-variant: '#2f4c42'
  secondary-fixed: '#e1e3e4'
  secondary-fixed-dim: '#c5c7c8'
  on-secondary-fixed: '#191c1d'
  on-secondary-fixed-variant: '#454748'
  tertiary-fixed: '#e0e3e6'
  tertiary-fixed-dim: '#c4c7ca'
  on-tertiary-fixed: '#181c1e'
  on-tertiary-fixed-variant: '#43474a'
  background: '#fcf9f8'
  on-background: '#1c1b1b'
  surface-variant: '#e5e2e1'
typography:
  display-lg:
    fontFamily: Literata
    fontSize: 48px
    fontWeight: '600'
    lineHeight: '1.2'
    letterSpacing: -0.02em
  display-lg-mobile:
    fontFamily: Literata
    fontSize: 32px
    fontWeight: '600'
    lineHeight: '1.25'
  headline-md:
    fontFamily: Literata
    fontSize: 24px
    fontWeight: '500'
    lineHeight: '1.4'
  body-lg:
    fontFamily: Geist
    fontSize: 18px
    fontWeight: '400'
    lineHeight: '1.6'
  body-md:
    fontFamily: Geist
    fontSize: 16px
    fontWeight: '400'
    lineHeight: '1.5'
  label-sm:
    fontFamily: Geist
    fontSize: 12px
    fontWeight: '600'
    lineHeight: '1'
    letterSpacing: 0.05em
  interface-md:
    fontFamily: Geist
    fontSize: 14px
    fontWeight: '500'
    lineHeight: '1.2'
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  base: 4px
  xs: 0.5rem
  sm: 1rem
  md: 1.5rem
  lg: 2.5rem
  xl: 4rem
  gutter: 24px
  margin-desktop: 48px
  margin-mobile: 16px
---

## Brand & Style

This design system centers on the "Focus-First" philosophy, prioritizing the act of creation and the clarity of thought. The target audience includes professional writers, editors, and content strategists who require a workspace that is both highly functional and visually calming. 

The aesthetic is **Refined Minimalism**. It avoids the sterility of pure utilitarianism by introducing subtle depth and sophisticated typography. The emotional response should be one of "quiet productivity"—a digital environment that recedes into the background to let the content lead. Key characteristics include expansive white space, a high-contrast type scale, and a restrained use of color to signal intent rather than decoration.

## Colors

The palette is anchored by a deep, sophisticated emerald green (`#0D2B22`) used for primary actions and brand presence. This color suggests growth and stability while maintaining a professional edge. 

The background hierarchy relies on a series of "soft neutrals." The primary canvas is white, while secondary surfaces like sidebars or secondary navigation use a very light gray (`#F8F9FA`) to provide subtle structural separation without harsh lines. Semantic colors are intentionally muted—sage, coral, and amber—to ensure they communicate status clearly without disrupting the high-contrast readability of the text.

## Typography

This design system employs a dual-font strategy to balance editorial elegance with technical precision. 

**Literata** (Serif) is reserved for headlines and long-form content previews. Its bookish nature reinforces the "writing" context and provides a high-end, published feel.

**Geist** (Sans-Serif) handles all interface elements, navigation, and labels. Its technical, monolinear construction ensures clarity at small sizes and maintains the minimalist, modern aesthetic of the platform's tools.

For long-form reading, the `body-lg` role should be used with a maximum line width of 720px to ensure optimal eye tracking.

## Layout & Spacing

The layout follows a **Fixed Grid** philosophy for dashboard views and a **Fluid Centered** model for writing views. 

- **Dashboards:** Utilize a 12-column grid with a 24px gutter. Content is housed in cards that span 3, 4, 6, or 12 columns.
- **Writing Workspace:** A single-column fluid container centered on the screen, maximizing whitespace on the left and right to eliminate distractions.
- **Sidebars:** Fixed at 280px for primary navigation and 320px for contextual utility panels (AI tools, metadata).

Spacing follows a 4px base unit, favoring larger gaps (`lg` and `xl`) between major sections to maintain the "airy" feel of the brand.

## Elevation & Depth

Hierarchy is established through **Tonal Layering** and **Ambient Shadows**. 

Surfaces do not "float" aggressively; instead, they sit just above the base layer. Shadows are extremely diffused, using low-opacity (4-8%) neutral tints. 
- **Level 0:** Base background (White).
- **Level 1:** Sidebars and secondary containers (Light Gray).
- **Level 2:** Content cards and modals. These use a 1px border (`#E9ECEF`) and a soft, wide-spread shadow to denote interactivity.

The goal is to create a tactile sense of paper sheets stacked neatly on a desk, avoiding the synthetic look of heavy gradients or high-contrast drop shadows.

## Shapes

The shape language is **Soft** and structured. A consistent 0.25rem (4px) radius is applied to standard UI elements like buttons and input fields to maintain a professional, sharp-edged feel while removing the harshness of true 90-degree corners. 

Larger containers like cards and modals utilize `rounded-lg` (8px) to soften the overall layout and make the environment feel more approachable. Status badges and tags use a full pill-shape to distinguish them from interactive buttons.

## Components

### Buttons & Controls
- **Primary:** Solid emerald green with white text. High contrast, 4px radius.
- **Secondary:** Transparent with a 1px emerald border.
- **Tertiary:** Ghost style, using primary color text with no background until hover.

### Input Fields
- **Style:** Outlined. 1px border (`#E9ECEF`), turning to emerald on focus. 
- **Typography:** Uses `interface-md` (Geist). Labels are placed above the field in `label-sm` (Geist, Uppercase).

### Status Badges
- Small, pill-shaped indicators for "AI Check," "Plagiarism," and "Status."
- Use muted semantic backgrounds with dark-tinted text of the same hue for a sophisticated "tone-on-tone" effect.

### Cards
- White background, 1px light gray border, and a Level 2 ambient shadow.
- Inner padding is consistent at 24px (`md`).

### Sidebar Navigation
- Vertical layout with a `#F8F9FA` background. 
- Active states are indicated by a 2px vertical "needle" on the far left in the primary emerald color and a subtle weight change in the Geist typeface.