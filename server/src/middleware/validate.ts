import type { Request, Response, NextFunction } from "express";
import type { ZodSchema } from "zod/v3";

export function validate(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction) => {
    req.body = schema.parse(req.body);
    next();
  };
}
