import * as PIXI from 'pixi.js';
import geojsonRewind from '@mapbox/geojson-rewind';
import { vecLength, geomGetSmallestSurroundingRectangle } from '@id-sdk/math';

import { getPixiTagPatternKey } from './pixiHelpers';
import { prefs } from '../core/preferences';

const PARTIALFILLWIDTH = 32;


export function pixiAreas(context, featureCache) {
  let _textures = {};
  let _didInit = false;

  //
  // prepare template geometry
  //
  function init() {
    const square = new PIXI.Graphics()
      .lineStyle(1, 0xffffff)
      .beginFill(0xffffff, 0.3)
      .drawRect(-5, -5, 10, 10)
      .endFill();

    // const ell = new PIXI.Graphics()
    //   .lineStyle(1, 0xffffff)
    //   .beginFill(0xffffff, 0.5)
    //   .drawPolygon([-5,-5, 5,-5, 5,5, 1,5, 1,1, -5,1, -5,-5])
    //   .endFill();

    // convert graphics to textures/sprites for performance
    // https://stackoverflow.com/questions/50940737/how-to-convert-a-graphic-to-a-sprite-in-pixijs
    const renderer = context.pixi.renderer;
    const options = { resolution: 2 };
    _textures.square = renderer.generateTexture(square, options);
    // _textures.ell = renderer.generateTexture(ell, options);

    _didInit = true;
  }


  //
  // render
  //
  function renderAreas(layer, projection, entities) {
    if (!_didInit) init();

    const graph = context.graph();
    const k = projection.scale();
    const fillstyle = (prefs('area-fill') || 'partial');
    const SHOWBBOX = false;

    function isPolygon(entity) {
      return (entity.type === 'way' || entity.type === 'relation') && entity.geometry(graph) === 'area';
    }

    // enter/update
    entities
      .filter(isPolygon)
      .forEach(function prepareAreas(entity) {
        let feature = featureCache.get(entity.id);

        if (!feature) {   // make poly if needed
          const style = styleMatch(entity.tags);
          const geojson = geojsonRewind(entity.asGeoJSON(graph), true);
          const polygons = (geojson.type === 'Polygon') ? [geojson.coordinates]
            : (geojson.type === 'MultiPolygon') ? geojson.coordinates : [];

          const bounds = new PIXI.Rectangle();

          const container = new PIXI.Container();
          container.name = entity.id;
          const area = entity.extent(graph).area();  // estimate area from extent for speed
          container.zIndex = -area;                  // sort by area descending (small things above big things)
          layer.addChild(container);

          const lowRes = new PIXI.Sprite(_textures.square);
          // const lowRes = new PIXI.Sprite(_textures.ell);
          lowRes.name = entity.id + '-lowRes';
          lowRes.anchor.set(0.5, 0.5);  // middle, middle
          lowRes.visible = false;
          container.addChild(lowRes);

          const fill = new PIXI.Graphics();
          fill.name = entity.id + '-fill';
          container.addChild(fill);

          const stroke = new PIXI.Graphics();
          stroke.name = entity.id + '-stroke';
          container.addChild(stroke);

          const mask = new PIXI.Graphics();
          mask.name = entity.id + '-mask';
          container.addChild(mask);

          const bbox = new PIXI.Graphics();
          bbox.name = entity.id + '-bbox';
          bbox.visible = SHOWBBOX;
          container.addChild(bbox);


// // SSR Experiment:
// const ssr = new PIXI.Graphics();
// ssr.name = entity.id + '-ssr';
// ssr.visible = SHOWBBOX;
// container.addChild(ssr);

          const pattern = getPixiTagPatternKey(context, entity.tags);
          const texture = pattern && context.pixi.rapidTextures.get(pattern);

          feature = {
            type: 'area',
            displayObject: container,
            bounds: bounds,
            style: style,
            polygons: polygons,
            texture: texture,
            lowRes: lowRes,
            fill: fill,
            stroke: stroke,
            mask: mask,
            bbox: bbox
// ssr: ssr
          };

          featureCache.set(entity.id, feature);
        }

        // Remember scale and reproject only when it changes
        if (k === feature.k) return;
        feature.k = k;

// Refresh the GeoJSON to deal with multipolygons not being fully loaded initially?
// This is wasteful, but we can work around it
// TODO : figure out a way to invalidate and redo geometry as we load more stuff from the OSM API.
const geojson = geojsonRewind(entity.asGeoJSON(graph), true);
const polygons = (geojson.type === 'Polygon') ? [geojson.coordinates]
  : (geojson.type === 'MultiPolygon') ? geojson.coordinates : [];
feature.polygons = polygons;


        // Reproject and recalculate the bounding box
        let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
        let shapes = [];

        // Convert the GeoJSON style multipolygons to array of Pixi polygons with inner/outer
        feature.polygons.forEach(rings => {
          if (!rings.length) return;  // no rings?

          let shape = { outer: undefined, holes: [] };
          shapes.push(shape);

          rings.forEach((ring, index) => {
            const isOuter = (index === 0);
            let points = [];

// // SSR Experiment:
// // If this is an uncomplicated area (no multiple outers)
// // perform a one-time calculation of smallest surrounding rectangle (SSR).
// // Maybe we will use it as a replacement geometry at low zooms.
let projectedring = [];

            ring.forEach(coord => {
              const [x, y] = projection.project(coord);
              points.push(x, y);
projectedring.push([x, y]);

              if (isOuter) {   // outer rings define the bounding box
                [minX, minY] = [Math.min(x, minX), Math.min(y, minY)];
                [maxX, maxY] = [Math.max(x, maxX), Math.max(y, maxY)];
              }
            });

if (isOuter && !feature.ssrdata && feature.polygons.length === 1) {
  let ssr = geomGetSmallestSurroundingRectangle(projectedring);   // compute SSR in projected coordinates
  if (ssr && ssr.poly) {

    // Calculate axes of symmetry to determine width, height
    // The shape's surrounding rectangle has 2 axes of symmetry.
    //
    //       1
    //   p1 /\              p1 = midpoint of poly[0]-poly[1]
    //     /\ \ q2          q1 = midpoint of poly[2]-poly[3]
    //   0 \ \/\
    //      \/\ \ 2         p2 = midpoint of poly[3]-poly[0]
    //    p2 \ \/           q2 = midpoint of poly[1]-poly[2]
    //        \/ q1
    //        3

    const p1 = [(ssr.poly[0][0] + ssr.poly[1][0]) / 2, (ssr.poly[0][1] + ssr.poly[1][1]) / 2 ];
    const q1 = [(ssr.poly[2][0] + ssr.poly[3][0]) / 2, (ssr.poly[2][1] + ssr.poly[3][1]) / 2 ];
    const p2 = [(ssr.poly[3][0] + ssr.poly[4][0]) / 2, (ssr.poly[3][1] + ssr.poly[4][1]) / 2 ];
    const q2 = [(ssr.poly[1][0] + ssr.poly[2][0]) / 2, (ssr.poly[1][1] + ssr.poly[2][1]) / 2 ];
    const axis1 = [p1, q1];
    const axis2 = [p2, q2];
    const centroid = [ (p1[0] + q1[0]) / 2, (p1[1] + q1[1]) / 2 ];
    feature.ssrdata = {
      poly: ssr.poly.map(coord => projection.invert(coord)),   // but store in raw wgsr84 coordinates
      axis1: axis1.map(coord => projection.invert(coord)),
      axis2: axis2.map(coord => projection.invert(coord)),
      centroid: projection.invert(centroid),
      angle: ssr.angle
    };
  }
}
            const poly = new PIXI.Polygon(points);
            if (isOuter) {
              shape.outer = poly;
            } else {
              shape.holes.push(poly);
            }
          });
        });

        const [w, h] = [maxX - minX, maxY - minY];
        feature.bounds.x = minX;
        feature.bounds.y = minY;
        feature.bounds.width = w;
        feature.bounds.height = h;


        // Determine style info
        let color = feature.style.color || 0xaaaaaa;
        let alpha = feature.style.alpha || 0.25;
        let texture = feature.texture || PIXI.Texture.WHITE;  // WHITE turns off the texture
        let doPartialFill = (fillstyle === 'partial');

        // If this shape is so small that partial filling makes no sense, fill fully (faster?)
        const cutoff = (2 * PARTIALFILLWIDTH) + 5;
        if (w < cutoff || h < cutoff) {
          doPartialFill = false;
        }
        // If this shape is so small that texture filling makes no sense, skip it (faster?)
        if (w < 32 || h < 32) {
          texture = PIXI.Texture.WHITE;
        }

// If this shape small, swap with ssr?
        if ((w < 20 || h < 20) && feature.ssrdata) {
          const ssrdata = feature.ssrdata;
          feature.fill.visible = false;
          feature.stroke.visible = false;
          feature.mask.visible = false;

          feature.lowRes.visible = true;

          const [x, y] = projection.project(ssrdata.centroid);
          const axis1 = ssrdata.axis1.map(coord => projection.project(coord));
          const axis2 = ssrdata.axis2.map(coord => projection.project(coord));
          const w = vecLength(axis1[0], axis1[1]);
          const h = vecLength(axis2[0], axis2[1]);

          feature.lowRes.position.set(x, y);
          feature.lowRes.scale.set(w / 10, h / 10);   // our sprite is 10x10
          feature.lowRes.rotation = ssrdata.angle;
          feature.lowRes.tint = color;
          return;

        } else {
          feature.fill.visible = true;
          feature.stroke.visible = true;
          feature.lowRes.visible = false;
        }

        // redraw the shapes

        // STROKES
        feature.stroke
          .clear()
          .lineStyle({
            alpha: 1,
            width: feature.style.width || 2,
            color: color
          });

        shapes.forEach(shape => {
          feature.stroke.drawShape(shape.outer);
          shape.holes.forEach(hole => feature.stroke.drawShape(hole));
        });


        // FILLS
        feature.fill.clear();
        shapes.forEach(shape => {
          feature.fill
            .beginTextureFill({
              alpha: alpha,
              color: color,
              texture: texture
            })
            .drawShape(shape.outer);

          if (shape.holes.length) {
            feature.fill.beginHole();
            shape.holes.forEach(hole => feature.fill.drawShape(hole));
            feature.fill.endHole();
          }
          feature.fill.endFill();
        });

        if (doPartialFill) {   // mask around the edges of the fill
          feature.mask
            .clear()
            .lineTextureStyle({
              alpha: 1,
              alignment: 0,  // inside (will do the right thing even for holes, as they are wound correctly)
              width: PARTIALFILLWIDTH,
              color: 0x000000,
              texture: PIXI.Texture.WHITE
            });

          shapes.forEach(shape => {
            feature.mask.drawShape(shape.outer);
            shape.holes.forEach(hole => feature.mask.drawShape(hole));
          });

          feature.mask.visible = true;
          feature.fill.mask = feature.mask;

        } else {  // full fill - no mask
          feature.mask.visible = false;
          feature.fill.mask = null;
        }

        if (SHOWBBOX) {
          feature.bbox
            .clear()
            .lineStyle({
              width: 1,
              color: doPartialFill ? 0xffff00 : 0x66ff66,
              alignment: 0   // inside
            })
            .drawShape(feature.bounds);

// // SSR Experiment:
// if (feature.ssrdata) {
//   let ssrpath = [];
//   feature.ssrdata.poly.forEach(coord => {
//     const [x, y] = projection.project(coord);  // display in projected coordinates
//     ssrpath.push(x, y);
//   });
//
//   feature.ssr
//     .clear()
//     .lineStyle({
//       width: 1,
//       color: 0x66ffff,
//       alignment: 0   // inside
//     })
//     .drawShape(new PIXI.Polygon(ssrpath));
// }
        }

      });
  }

  return renderAreas;
}


const STYLES = {
  red: {
    width: 2,
    color: 0xe06e5f,  // rgba(224, 110, 95)
    alpha: 0.3
  },
  green: {
    width: 2,
    color: 0x8cd05f,  // rgb(140, 208, 95)
    alpha: 0.3
  },
  blue: {
    width: 2,
    color: 0x77d4de,  // rgb(119, 211, 222)
    alpha: 0.3
  },
  yellow: {
    width: 2,
    color: 0xffff94,  // rgb(255, 255, 148)
    alpha: 0.25
  },
  gold: {
    width: 2,
    color: 0xc4be19,  // rgb(196, 189, 25)
    alpha: 0.3
  },
  orange: {
    width: 2,
    color: 0xd6881a,  // rgb(214, 136, 26)
    alpha: 0.3
  },
  pink: {
    width: 2,
    color: 0xe3a4f5,  // rgb(228, 164, 245)
    alpha: 0.3
  },
  teal: {
    width: 2,
    color: 0x99e1aa,  // rgb(153, 225, 170)
    alpha: 0.3
  },
  lightgreen: {
    width: 2,
    color: 0xbee83f,  // rgb(191, 232, 63)
    alpha: 0.3
  },
  tan: {
    width: 2,
    color: 0xf5dcba,  // rgb(245, 220, 186)
    alpha: 0.3
  },
  darkgray: {
    width: 2,
    color: 0x8c8c8c,  // rgb(140, 140, 140)
    alpha: 0.5
  },
  lightgray: {
    width: 2,
    color: 0xaaaaaa,  // rgb(170, 170, 170)
    alpha: 0.3
  }
};

const TAGSTYLES = {
  amenity: {
    fountain: 'blue',
    childcare: 'yellow',
    kindergarten: 'yellow',
    school: 'yellow',
    college: 'yellow',
    university: 'yellow',
    research_institute: 'yellow',
    parking: 'darkgray'
  },
  building: {
    '*': 'red'
  },
  construction: {
    '*': 'gold'
  },
  barrier: {
    hedge: 'green'
  },
  golf: {
    'green': 'lightgreen'
  },
  landuse: {
    flowerbed: 'green',
    forest: 'green',
    grass: 'green',
    recreation_ground: 'green',
    village_green: 'green',
    residential: 'gold',
    retail: 'orange',
    commercial: 'orange',
    landfill: 'orange',
    military: 'orange',
    industrial: 'pink',
    cemetery: 'lightgreen',
    farmland: 'lightgreen',
    meadow: 'lightgreen',
    orchard: 'lightgreen',
    vineyard: 'lightgreen',
    farmyard: 'tan',
    railway: 'darkgray',
    quarry: 'darkgray'
  },
  leisure: {
    garden: 'green',
    golf_course: 'green',
    nature_reserve: 'green',
    park: 'green',
    pitch: 'green',
    track: 'yellow',
    swimming_pool: 'blue'
  },
  man_made: {
    adit: 'darkgray',
    groyne: 'darkgray',
    breakwater: 'darkgray'
  },
  military: {
    '*': 'orange'
  },
  natural: {
    bay: 'blue',
    water: 'blue',
    beach: 'yellow',
    sand: 'yellow',
    scrub: 'yellow',
    wetland: 'teal',
    bare_rock: 'darkgray',
    cave_entrance: 'darkgray',
    cliff: 'darkgray',
    rock: 'darkgray',
    scree: 'darkgray',
    stone: 'darkgray',
    shingle: 'darkgray',
    glacier: 'lightgray',
    '*': 'green'
  },
  power: {
    'plant': 'pink'
  },
  sport: {
    beachvolleyball: 'yellow',
    baseball: 'yellow',
    softball: 'yellow',
    basketball: 'darkgray',
    skateboard: 'darkgray'
  },
  waterway: {
    dam: 'darkgray',
    weir: 'darkgray'
  }
};


export function styleMatch(tags) {
  let style = STYLES.lightgray;  // default
  let selectivity = 999;

  for (const k in tags) {
    const v = tags[k];
    const group = TAGSTYLES[k];
    if (!group || !v) continue;

    // smaller groups are more selective
    let groupsize = Object.keys(group).length;
    let stylename = group[v];
    if (!stylename) stylename = group['*'];  // fallback value

    if (stylename && groupsize < selectivity) {
      style = STYLES[stylename];
      selectivity = groupsize;
      if (selectivity === 1) break;  // no need to keep looking at tags
    }
  }

  return style;
}
