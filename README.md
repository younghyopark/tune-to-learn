# 🎓 Academic Project Page Template

A clean, flexible project website template for publishing interactive versions of research papers.  
No build tools, no frameworks — just **HTML + CSS + JS** that you can edit directly and deploy to GitHub Pages.

---

## 📁 Structure

```
.
├── index.html              ← Main page (edit this!)
├── static/
│   ├── css/
│   │   └── style.css       ← All styles (colors, layout, components)
│   ├── js/
│   │   └── script.js       ← Interactive features (tabs, carousel, slider)
│   ├── images/             ← Put your figures here
│   └── videos/             ← Put your videos here
└── README.md
```

---

## 🚀 Quick Start

1. **Edit `index.html`** — Replace placeholder text, images, and links with your content.
2. **Drop assets** into `static/images/` and `static/videos/`.
3. **Push to GitHub** and enable GitHub Pages (Settings → Pages → Source: `main` / root).

That's it! No `npm install`, no build step.

---

## 🧩 Available Components

### Hero / Title Section
- Paper title, subtitle, author list with links
- Affiliation badges, venue/award badges
- Quick-link buttons (paper PDF, code, video, dataset, arXiv)

### Teaser Figure
- Full-width figure with caption, floating card style

### Video Embed
- **YouTube**: Just change the `src` URL in the `<iframe>`
- **Self-hosted MP4**: Uncomment the `<video>` block, set `src`

### Tabbed Content
- Switch between views (e.g., Training / Inference / Architecture)
- Each tab holds any HTML — images, text, code, interactive widgets
- Add more tabs: add a `<button data-tab="tab-N">` and `<div id="tab-N">`

### Image Comparison Slider
- Drag to compare two images side-by-side
- Replace the placeholder `<div>` with `<img>` tags
- Labels configurable ("Ours" / "Baseline")

### Video Grid
- Responsive grid of video cards
- Supports `<video>`, `<img>` (GIFs), or embedded players

### Image Carousel
- Left/right arrows, dot navigation, touch swipe, keyboard support
- Add slides: duplicate a `<div class="carousel-slide">` inside the track

### Results Table
- Clean styled table with highlighted best-result row
- Add rows/columns as needed

### Interactive Embed (iframe)
- Embed any external tool: Gradio, Plotly, Three.js, custom HTML
- Set `src` to your demo URL

### Figure Grid
- `cols-2`, `cols-3`, `cols-4` classes for multi-column figure layouts
- Responsive — collapses on mobile

### Math (KaTeX)
- Inline: `$f(x) = x^2$`
- Display: `$$\sum_{i=1}^{N} x_i$$`

### BibTeX Block
- Dark-themed code block with one-click copy button

---

## 🎨 Customization

### Colors
Edit the CSS custom properties at the top of `static/css/style.css`:

```css
:root {
  --primary:      #2563eb;   /* Main accent color */
  --primary-dark: #1d4ed8;
  --bg-hero:      #0f172a;   /* Dark hero background */
  --text:         #1e293b;
  /* ... etc */
}
```

### Adding a New Section

```html
<section class="section" id="my-section">
  <div class="container">
    <h2>Section Title</h2>
    <!-- your content -->
  </div>
</section>
```

Use `class="section alt-bg"` for alternating background.  
Use `<div class="container-narrow">` for narrower text columns.

### Replacing Placeholder Images

Find any `<div class="placeholder-img">` and replace with:
```html
<img src="static/images/your-figure.png" alt="Description" />
```

### Adding Videos

**Self-hosted:**
```html
<video controls muted playsinline loop>
  <source src="static/videos/demo.mp4" type="video/mp4" />
</video>
```

**YouTube:**
```html
<div class="video-container">
  <iframe src="https://www.youtube.com/embed/VIDEO_ID" allowfullscreen></iframe>
</div>
```

### Embedding Interactive Demos

```html
<iframe src="https://your-gradio-app.hf.space" style="width:100%; height:600px; border:none;"></iframe>
```

Works with: Gradio, Streamlit, Plotly, Three.js, D3, Observable, or any URL.

### Lazy-Loading Videos

For pages with many videos, add `data-src` for lazy loading:
```html
<video data-src muted playsinline loop>
  <source data-src="static/videos/heavy.mp4" type="video/mp4" />
</video>
```

---

## 📱 Responsive Design

The template is fully responsive:
- **Desktop**: Full multi-column layouts
- **Tablet**: Graceful column reduction
- **Mobile**: Single-column stack, smaller fonts/buttons

---

## 🖨 Print

Print styles are included — hero goes white, interactive controls are hidden.

---

## 📦 Deployment

### GitHub Pages
1. Push to a GitHub repo
2. Go to Settings → Pages
3. Set source to `main` branch, `/ (root)` folder
4. Your site will be at `https://username.github.io/repo-name/`

### Custom Domain
Add a `CNAME` file with your domain, then configure DNS.

---

## License

This template is free to use and modify for academic purposes.
