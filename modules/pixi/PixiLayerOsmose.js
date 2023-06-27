import { AbstractLayer } from './AbstractLayer';
import { PixiFeaturePoint } from './PixiFeaturePoint';

const MINZOOM = 12;


/**
 * PixiLayerOsmose
 * @class
 */
export class PixiLayerOsmose extends AbstractLayer {

  /**
   * @constructor
   * @param  scene    The Scene that owns this Layer
   * @param  layerID  Unique string to use for the name of this Layer
   */
  constructor(scene, layerID) {
    super(scene, layerID);
  }


  /**
   * supported
   * Whether the Layer's service exists
   */
  get supported() {
    return !!this.context.services.osmose;
  }


  /**
   * renderMarkers
   * @param  frame        Integer frame being rendered
   * @param  projection   Pixi projection to use for rendering
   * @param  zoom         Effective zoom to use for rendering
   */
  renderMarkers(frame, projection, zoom) {
    const service = this.context.services.osmose;
    if (!service) return;

    const parentContainer = this.scene.groups.get('qa');
    const items = service.getItems(this.context.projection);

    for (const d of items) {
      const featureID = `${this.layerID}-${d.id}`;
      let feature = this.features.get(featureID);

      if (!feature) {
        const style = {
          markerName: 'osmose',
          markerTint: service.getColor(d.item),
          iconName: d.icon
        };

        feature = new PixiFeaturePoint(this, featureID);
        feature.geometry.setCoords(d.loc);
        feature.style = style;
        feature.parentContainer = parentContainer;
        feature.setData(d.id, d);
      }

      this.syncFeatureClasses(feature);
      feature.update(projection, zoom);
      if (!feature._isCircular) {  // offset the icon to fit better in the "osmose" pin
        feature.icon.position.set(0, -17);
      }

      this.retainFeature(feature, frame);
    }
  }


  /**
   * render
   * Render any data we have, and schedule fetching more of it to cover the view
   * @param  frame        Integer frame being rendered
   * @param  projection   Pixi projection to use for rendering
   * @param  zoom         Effective zoom to use for rendering
   */
  render(frame, projection, zoom) {
    const service = this.context.services.osmose;
    if (!this.enabled || !service || zoom < MINZOOM) return;

    service.loadIssues(this.context.projection);  // note: context.projection !== pixi projection
    this.renderMarkers(frame, projection, zoom);
  }

}
