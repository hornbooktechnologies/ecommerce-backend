import { Router } from "express";
import { createAuthController } from "./auth.controller.js";
import { authenticate } from "./auth.middleware.js";
import { changePasswordSchema, forgotPasswordSchema, loginSchema, resetPasswordSchema,
  validateBody } from "./auth.validators.js";

export function createAuthRouter({ authenticationService } = {}) {
  const router = Router();
  const controller = createAuthController(authenticationService);

  router.post("/login", validateBody(loginSchema), controller.login);
  router.post("/password/forgot", validateBody(forgotPasswordSchema), controller.forgotPassword);
  router.post("/password/reset", validateBody(resetPasswordSchema), controller.resetPassword);
  router.patch("/password", authenticate, validateBody(changePasswordSchema), controller.changePassword);
  router.post("/refresh", controller.refresh);
  router.post("/logout", controller.logout);
  router.get("/me", authenticate, controller.me);

  return router;
}
