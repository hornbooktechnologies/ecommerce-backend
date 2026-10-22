import * as defaultAuthenticationService from "./auth.service.js";
import {
  clearRefreshCookieOptions,
  readCookie,
  refreshCookieName,
  refreshCookieOptions
} from "./auth.cookies.js";

function requestMetadata(req) {
  return {
    deviceName: req.validated?.body?.deviceName || null,
    ipAddress: req.ip,
    userAgent: req.get("user-agent") || null
  };
}

export function createAuthController(authenticationService = defaultAuthenticationService) {
  return {
    async login(req, res) {
      const result = await authenticationService.login({
        ...req.validated.body,
        ...requestMetadata(req)
      });
      res.cookie(refreshCookieName, result.refreshToken, refreshCookieOptions());
      res.status(200).json({
        data: { accessToken: result.accessToken, user: result.user }
      });
    },

    async refresh(req, res) {
      const result = await authenticationService.refresh({
        refreshToken: readCookie(req, refreshCookieName),
        ...requestMetadata(req)
      });
      res.cookie(refreshCookieName, result.refreshToken, refreshCookieOptions());
      res.status(200).json({
        data: { accessToken: result.accessToken, user: result.user }
      });
    },

    async logout(req, res) {
      await authenticationService.logout({
        refreshToken: readCookie(req, refreshCookieName)
      });
      res.clearCookie(refreshCookieName, clearRefreshCookieOptions());
      res.status(204).end();
    },

    async forgotPassword(req, res) {
      const result = await authenticationService.requestPasswordReset({
        ...req.validated.body,
        ...requestMetadata(req)
      });
      res.status(202).json({ data: result });
    },

    async resetPassword(req, res) {
      await authenticationService.resetPassword(req.validated.body);
      res.clearCookie(refreshCookieName, clearRefreshCookieOptions());
      res.status(204).end();
    },

    async changePassword(req, res) {
      await authenticationService.changePassword({
        userId: req.context.actor.userId,
        ...req.validated.body
      });
      res.clearCookie(refreshCookieName, clearRefreshCookieOptions());
      res.status(204).end();
    },

    async me(req, res) {
      const user = await authenticationService.getCurrentUser({
        userId: req.context.actor.userId
      });
      res.json({ data: { user } });
    }
  };
}
