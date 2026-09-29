/**
 * The baked raster layers as the scene holds them: a container per layer, a sprite per
 * chunk, so a layer toggles as a whole while no single texture is too big to upload.
 */
import { Sprite, Texture } from 'pixi.js';
import type { Container } from 'pixi.js';
import type { LayerChunk } from '../coimap/types';

/** One sprite per chunk, placed in tile units, into a layer's container. */
export function addChunkSprites(container: Container, chunks: LayerChunk[]) {
  for (const chunk of chunks) {
    const texture = Texture.from(chunk.bitmap);
    // Nearest-neighbour keeps tile edges crisp instead of smearing when zoomed in.
    texture.source.scaleMode = 'nearest';
    const sprite = new Sprite(texture);
    sprite.position.set(chunk.x, chunk.y);
    sprite.width = chunk.w;
    sprite.height = chunk.h;
    container.addChild(sprite);
  }
}

/**
 * Swaps a layer's pixels for a re-baked set, keeping its place in the draw order and its
 * visibility, which both belong to the container.
 *
 * The old textures are destroyed with their sources and the bitmaps closed, not left for
 * the collector: each full layer is 55 MB of GPU memory on a large map, and flipping the
 * colouring back and forth would otherwise stack copies of it until the context is lost.
 */
export function replaceChunkSprites(container: Container, chunks: LayerChunk[]) {
  for (const child of container.removeChildren()) {
    const sprite = child as Sprite;
    const bitmap = sprite.texture.source.resource as ImageBitmap | undefined;
    sprite.destroy({ texture: true, textureSource: true });
    bitmap?.close?.();
  }
  addChunkSprites(container, chunks);
}
