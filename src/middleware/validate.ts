import type { NextFunction, Request, Response } from "express";
import type { ZodTypeAny } from "zod";

type ValidationSchemas = {
  body?: ZodTypeAny;
  params?: ZodTypeAny;
  query?: ZodTypeAny;
};

function ensureValidated(req: Request) {
  req.validated ??= {};
  return req.validated;
}

export function validate(schemas: ValidationSchemas) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const validated = ensureValidated(req);

      if (schemas.body) {
        const body = schemas.body.parse(req.body);
        req.body = body;
        validated.body = body;
      }

      if (schemas.params) {
        const params = schemas.params.parse(req.params);
        req.params = params;
        validated.params = params;
      }

      if (schemas.query) {
        // Express 5 exposes req.query as a getter-only property, so never assign to it.
        // Keep the parsed/coerced query object in req.validated.query instead.
        validated.query = schemas.query.parse(req.query);
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

export function getValidatedQuery<T>(req: Request): T {
  return req.validated?.query as T;
}
