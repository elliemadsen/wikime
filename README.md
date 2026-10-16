# Wikime

A website spatializing the Wikipedia pages I collect in this [Are.na channel](https://www.are.na/channel/wiki-f5ptsfqepas).

## Running it

```sh
npm run serve
```

To refresh the site after saving new pages to the channel:

```sh
npm install      # once; only the data script needs these packages
npm run data     # fetch Are.na + Wikipedia, write public/graph.json (cached in cache/)
```

Then commit and push `public/graph.json`. Wikipedia responses are cached in `cache/`, so only new
pages are fetched; delete that folder to refresh everything.

## Implementation details

`scripts/build.mjs`:

1. **Saved pages**: every Wikipedia link in the channel, with titles normalised and redirects
   resolved (the nested channel is skipped).
2. **Links**: for each saved page, the links in the article body (Parsoid HTML with navboxes,
   sidebars, references and "External links" removed), plus pages that link to it (backlinks).
3. **Connecting pages**: any page linked to or from two or more saved pages is a candidate. The
   top candidates are verified by reading their own article bodies, then scored by how many saved
   pages they touch, damped by how link-heavy they are (e.g. "Mathematics" scores below
   "Dimensionality reduction"). The top 400 become the zoom-in layer, plus up to 5
   single-neighbour pages per saved page.
4. **Similarity** between saved pages = direct links + shared connecting pages (damped the same way).
5. **Layout**: force-directed in 2D (with saved labels kept from overlapping) and on a sphere
   (a 3D force layout with every node pinned to the surface).

Tuning parameters are in `scripts/build.mjs`.

## Code

- `src/scene.js`: shared canvas renderer (level of detail, label collisions, fades, hit-testing)
- `src/flat.js`: 2D pan/zoom view (off by default)
- `src/sphere.js`: globe view with free arcball rotation, outside or inside
- `src/main.js`: hover cards, search, path finder, frontier list, timeline

Some built features are switched off in `FEATURES` at the top of `src/main.js`: the flat 2D map,
the Frontier list, and drawing the connecting (unsaved) pages.

Deep links: `?side=inside&mode=image&page=Hysteresis&tool=path`.
