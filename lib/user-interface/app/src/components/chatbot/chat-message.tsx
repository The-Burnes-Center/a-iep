import {
  Box,
  Button,
  Container,
  Popover,
  Spinner,
  StatusIndicator,
  TextContent,
  SpaceBetween,
  ButtonDropdown,
  Modal,
  FormField,
  Input,
  Select
} from "@cloudscape-design/components";
import * as React from "react";
import { useState } from 'react';
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import styles from "../../styles/chat.module.scss";
import {
  ChatBotHistoryItem,
  ChatBotMessageType,
} from "./types";


import "react-json-view-lite/dist/index.css";
import "../../styles/app.scss";
import { useNotifications } from "../notif-manager";
import { Utils } from "../../common/utils";
import {feedbackCategories, feedbackTypes} from '../../common/constants'
import { AppContext } from "../../common/app-context"; 
import { useContext } from "react";
import { Auth } from "aws-amplify";

export interface ChatMessageProps {
  message: ChatBotHistoryItem; 
  messageKey: number;
  messageIndex: number;
  session: string; 
  onThumbsUp: () => void;
  onThumbsDown: (feedbackTopic : string, feedbackType : string, feedbackMessage: string) => void;  
  updateMessageConflictReport: (messageIndex: number, conflictReport: string) => void;
}

/** Shape of the source entries the API stores in message metadata */
interface SourceItem {
  title: string;
  uri: string;
}



export default function ChatMessage(props: ChatMessageProps) {
  const [loading] = useState<boolean>(false);
  const [selectedIcon, setSelectedIcon] = useState<1 | 0 | null>(null);
  const { addNotification, removeNotification } = useNotifications();
  const [modalVisible, setModalVisible] = useState(false);
  const [selectedTopic, setSelectedTopic] = React.useState({label: "Select a Topic", value: "1"});
  const [selectedFeedbackType, setSelectedFeedbackType] = React.useState({label: "Select a Problem", value: "1"});
  const [value, setValue] = useState("");
  const [conflictReport, setConflictReport] = useState(props.message.conflictReport || "");
  const [showConflictButton, setShowConflictButton] = useState(!props.message.conflictReport);
  const [loadingConflictReport, setLoadingConflictReport] = useState(false);
  const appContext = useContext(AppContext);



  const content =
    props.message.content && props.message.content.length > 0
      ? props.message.content
      : "";

      const handleConflictReport = async () => {
        if (loadingConflictReport) return; // Prevent multiple clicks
        setLoadingConflictReport(true);
    
        // get authenticated user
        let username;
        try {
          const user = await Auth.currentAuthenticatedUser();
          username = user.username;
          if (!username) throw new Error("Unable to get current user.");
        } catch (error) {
          addNotification("error", error.message);
          setLoadingConflictReport(false);
          return;
        }
    
        // setup websocket
        const TOKEN = await Utils.authenticate();
    
        // WebSocket endpoint
        const wsEndpoint = appContext.wsEndpoint;
        const wsUrl = `${wsEndpoint}/?Authorization=${TOKEN}`;
        const ws = new WebSocket(wsUrl);
    
        let conflictReportData = "";

        ws.addEventListener("open", () => {
          const messagePayload = JSON.stringify({
            action: "generateConflictReport",
            data: {
              key: props.messageKey,
              user_id: username,
              session_id: props.session,
            },
          });
          ws.send(messagePayload);
        });
    
        ws.addEventListener("message", (event) => {
          const data = event.data;
    
          if (data.includes("<!ERROR!>:")) {
            addNotification("error", data);
            ws.close();
            setLoadingConflictReport(false);
            return;
          }
          if (data === "!<|EOF_STREAM|>!") {
            // End of message
            ws.close();
            props.updateMessageConflictReport(props.messageIndex, conflictReportData);
            setLoadingConflictReport(false);
            setShowConflictButton(false);
            return;
          }
    
          // Append data to conflict report
          conflictReportData += data;
          setConflictReport((prev) => prev + data);
        });
    
        ws.addEventListener("error", (err) => {
          console.error("WebSocket error:", err);
          addNotification("error", "An error occurred with the WebSocket connection.");
          ws.close();
          setLoadingConflictReport(false);
        });
    
        ws.addEventListener("close", () => {
          setLoadingConflictReport(false);
          setShowConflictButton(false);
        });
      };
  
  const showSources = props.message.metadata?.Sources && (props.message.metadata.Sources as unknown as SourceItem[]).length > 0;
  
  // useEffect(() => {
  //   if (props.message.conflictReport) {
  //     setConflictReport(props.message.conflictReport);
  //     setShowConflictButton(false);
  //   }
  // }, [props.message.conflictReport]);

  return (
    <div>
      <Modal
      onDismiss={() => setModalVisible(false)}
      visible={modalVisible}
      footer={
        <Box float = "right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={() => {
              setModalVisible(false)
            setValue("")
            setSelectedTopic({label: "Select a Topic", value: "1"})
            setSelectedFeedbackType({label: "Select a Topic", value: "1"})
            }}
            >Cancel</Button>
            <Button variant="primary" onClick={() => {
              if (!selectedTopic.value || !selectedFeedbackType.value || selectedTopic.value === "1" || selectedFeedbackType.value === "1" || value.trim() === "") {
                const id = addNotification("error","Please fill out all fields.")
                Utils.delay(3000).then(() => removeNotification(id));
                return;
              } else {
              setModalVisible(false)
              setValue("")

              const id = addNotification("success","Your feedback has been submitted.")
              Utils.delay(3000).then(() => removeNotification(id));
              
              props.onThumbsDown(selectedTopic.value, selectedFeedbackType.value,value.trim());
              setSelectedIcon(0);

              setSelectedTopic({label: "Select a Topic", value: "1"})
              setSelectedFeedbackType({label: "Select a Problem", value: "1"})
              
              
            }}}>Ok</Button>
          </SpaceBetween>
        </Box>
      }
      header="Provide Feedback"
      >
        <SpaceBetween size="xs">
        <Select
        selectedOption = {selectedTopic}
        onChange = {({detail}) => setSelectedTopic({label: detail.selectedOption.label,value: detail.selectedOption.value})}
        options ={feedbackCategories}
        />
        <Select
        selectedOption = {selectedFeedbackType}
        onChange = {({detail}) => setSelectedFeedbackType({label: detail.selectedOption.label,value: detail.selectedOption.value})}
        options ={feedbackTypes}
        />
        <FormField label="Please enter feedback here">
          <Input
          onChange={({detail}) => setValue(detail.value)}
          value={value}
          />
        </FormField>
        </SpaceBetween>
      </Modal>
      {props.message?.type === ChatBotMessageType.AI && (
        <Container
        footer={
          showSources && (
            <SpaceBetween direction="horizontal" size="s">
              <ButtonDropdown
                items={(props.message.metadata.Sources as unknown as SourceItem[]).map((item) => {
                  return {
                    id: "id",
                    disabled: false,
                    text: item.title,
                    href: item.uri,
                    external: true,
                    externalIconAriaLabel: "(opens in new tab)",
                  };
                })}
              >
                Sources
              </ButtonDropdown>
              {showConflictButton && (
                <Button
                  variant="primary"
                  onClick={handleConflictReport}
                  disabled={loadingConflictReport}
                >
                  {loadingConflictReport ? "Generating Report..." : "Identify Source Conflicts"}
                </Button>
              )}
            </SpaceBetween>
          )
        }
        >
          {content?.length === 0 ? (
            <Box>
              <Spinner />
            </Box>
          ) : null}
          {props.message.content.length > 0 ? (
            <div className={styles.btn_chabot_message_copy}>
              <Popover
                size="medium"
                position="top"
                triggerType="custom"
                dismissButton={false}
                content={
                  <StatusIndicator type="success">
                    Copied to clipboard
                  </StatusIndicator>
                }
              >
                <Button
                  variant="inline-icon"
                  iconName="copy"
                  onClick={() => {
                    navigator.clipboard.writeText(props.message.content);
                  }}
                />
              </Popover>
            </div>
          ) : null}
          <ReactMarkdown
            children={content}
            remarkPlugins={[remarkGfm]}
            components={{
              pre(props) {
                const { children, ...rest } = props;
                return (
                  <pre {...rest} className={styles.codeMarkdown}>
                    {children}
                  </pre>
                );
              },
              table(props) {
                const { children, ...rest } = props;
                return (
                  <table {...rest} className={styles.markdownTable}>
                    {children}
                  </table>
                );
              },
              th(props) {
                const { children, ...rest } = props;
                return (
                  <th {...rest} className={styles.markdownTableCell}>
                    {children}
                  </th>
                );
              },
              td(props) {
                const { children, ...rest } = props;
                return (
                  <td {...rest} className={styles.markdownTableCell}>
                    {children}
                  </td>
                );
              },
            }}
          />
          <div className={styles.thumbsContainer}>
            {(selectedIcon === 1 || selectedIcon === null) && (
              <Button
                variant="icon"
                iconName={selectedIcon === 1 ? "thumbs-up-filled" : "thumbs-up"}
                onClick={() => {
                  props.onThumbsUp();
                  const id = addNotification("success","Thank you for your valuable feedback!")
                  Utils.delay(3000).then(() => removeNotification(id));
                  setSelectedIcon(1);
                }}
              />
            )}
            {(selectedIcon === 0 || selectedIcon === null) && (
              <Button
                iconName={
                  selectedIcon === 0 ? "thumbs-down-filled" : "thumbs-down"
                }
                variant="icon"
                onClick={() => {
                  // props.onThumbsDown();
                  // setSelectedIcon(0);
                  setModalVisible(true);
                }}
              />
            )}
          </div>
          {conflictReport && (
          <div className={styles.conflictReport}>
            <TextContent>
              <strong>Conflict Report:</strong>
              <p>{conflictReport}</p>
            </TextContent>
          </div>
        )}
        </Container>
      )}
      {loading && (
        <Box float="left">
          <Spinner />
        </Box>
      )}      
      {props.message?.type === ChatBotMessageType.Human && (
        <TextContent>
          <strong>{props.message.content}</strong>
        </TextContent>
      )}
    </div>
  );
}