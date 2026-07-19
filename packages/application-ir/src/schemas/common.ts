import { z } from "zod";

export const idSchema = z.string().regex(/^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/, {
  message: "Identifiers must match the pattern ^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$",
});

export const errorIdSchema = z.string().regex(/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/, {
  message: "Error identifiers must match the uppercase pattern ^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$",
});


export const semanticVersionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?$/, {
  message: "Must be a valid semantic version (e.g. 1.0.0)",
});

export const relativePathSchema = z.string().refine(
  (val) => {
    return !val.includes("..") && !val.includes("\\") && !val.startsWith("/") && !val.includes("\0");
  },
  {
    message: "Paths must be relative, use forward slashes, and must not escape the bundle root (no ..)",
  }
);
