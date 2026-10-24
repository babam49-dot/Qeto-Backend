import "dotenv/config";
import express from "express";
import cors from "cors";
import { prisma } from "./db.js";

const app= express();
app.use(cors());
app.use(express.json());

app.get("/health",async(_req,res)=>{
    try{
        await prisma.$queryRaw`SELECT 1`;
        res.json({status:"ok",database:"connected"}
        );
    }
        catch(error){
            console.error(error);
            res.status(500).json({status:"error",database:"unreachable"});

        }


});
const port=process.env.PORT||4000;
app.listen(port,()=>{
    console.log(`Qeto API running on http://localhost:${port}`);
});