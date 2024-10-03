import {
    validateEthAddress,
    validateRailgunAddress,
  } from "@railgun-community/wallet";
  import { confirmPromptCatch } from "./confirm-ui";
  
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Input } = require("enquirer");


  export const getMemoTextPrompt = async () =>{
    const prompt = new Input({
        header: " ",
        message: `Please enter your memo`,
        format: (value: string) =>{
            return `${value}`;
        }
    });

    const resultMemo = await prompt.run().catch((err: any)=>{
        console.log(err);
        return undefined;

    });

    if(resultMemo){
        return resultMemo
    }
    return undefined;
  }