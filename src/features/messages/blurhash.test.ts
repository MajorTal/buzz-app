import { afterEach, expect, it, vi } from "vitest";
import { decode } from "blurhash";
import { BLURHASH_SIZE, paintBlurhash } from "./blurhash";
vi.mock("blurhash", async (original) => ({
  ...(await original<typeof import("blurhash")>()),
  decode: vi.fn((await original<typeof import("blurhash")>()).decode),
}));
afterEach(() => vi.mocked(decode).mockClear());
const hash = "LEHV6nWB2yk8pyo0adR*.7kCMdnj";
function canvas() {
  const data = new Uint8ClampedArray(BLURHASH_SIZE ** 2 * 4);
  const context = {
    createImageData: vi.fn(() => ({ data })),
    putImageData: vi.fn(),
  };
  const element = { getContext: vi.fn(() => context) };
  return { element: element as unknown as HTMLCanvasElement, context, data };
}
it("uses the canonical decoder with a fixed tiny raster, with no source dimensions", () => {
  const { element, context, data } = canvas();
  paintBlurhash(element, hash);
  expect(decode).toHaveBeenCalledExactlyOnceWith(hash, 32, 32);
  expect(context.putImageData).toHaveBeenCalledOnce();
  expect(data.some((value) => value > 0)).toBe(true);
});
it("rejects invalid/oversized input before any canvas or decoder work", () => {
  const { element } = canvas();
  for (const value of [
    "invalid",
    "0".repeat(10000),
    "~000000000000000000000000000000000000000",
  ])
    paintBlurhash(element, value);
  expect(element.getContext).not.toHaveBeenCalled();
  expect(decode).not.toHaveBeenCalled();
});
it("contains decoder, unavailable canvas and raster write failures", () => {
  const { element, context } = canvas();
  vi.mocked(decode).mockImplementationOnce(() => {
    throw new Error("decode");
  });
  expect(() => paintBlurhash(element, hash)).not.toThrow();
  expect(context.putImageData).not.toHaveBeenCalled();
  context.putImageData.mockImplementationOnce(() => {
    throw new Error("canvas");
  });
  expect(() => paintBlurhash(element, hash)).not.toThrow();
  expect(() =>
    paintBlurhash(
      { getContext: () => null } as unknown as HTMLCanvasElement,
      hash,
    ),
  ).not.toThrow();
});
