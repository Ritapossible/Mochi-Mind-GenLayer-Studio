import { Router, type IRouter } from "express";
import healthRouter from "./health";
import leaderboardRouter from "./leaderboard";
import validatorRouter from "./validator";

const router: IRouter = Router();

router.use(healthRouter);
router.use(leaderboardRouter);
router.use(validatorRouter);

export default router;
