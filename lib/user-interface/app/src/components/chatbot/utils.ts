import {  
  ChatBotHistoryItem,  
  ChatBotMessageType,
} from "./types";


/**Assembles local message history copy into a format suitable for the chat API */
export function assembleHistory(history: ChatBotHistoryItem[]) {
  const hist: { user: string; chatbot: string; metadata: string }[] = [];
  for (let i = 0; i < history.length - 1; i++) {
    if (history[i].type == ChatBotMessageType.Human) {
      hist.push({ "user": history[i].content, "chatbot": history[i+1].content, "metadata" : JSON.stringify(history[i+1].metadata)})
    }
  }   
  
  return hist;
}
