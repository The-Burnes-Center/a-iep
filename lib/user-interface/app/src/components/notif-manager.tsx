import * as React from "react";
import { createContext, useState, useContext } from "react";
import { FlashbarProps } from "@cloudscape-design/components";
import { v4 as uuidv4 } from 'uuid';  // Import the UUID function

interface NotificationItem {
  id: string;
  type: FlashbarProps.Type;
  content: React.ReactNode;
  date: number;
  dismissible: boolean;
  dismissLabel: string;
  onDismiss: () => void;
}

// Create a context for the notification manager
// eslint-disable-next-line react-refresh/only-export-components -- the context object has to live beside its provider so consumers can import both from one place
export const NotificationContext = createContext<{
  notifications: NotificationItem[];
  addNotification: (type: FlashbarProps.Type, content: React.ReactNode) => string;
  removeNotification: (id: string) => void;
}>({
  notifications: [],
  addNotification: () => '',
  removeNotification: () => {}
});

export const NotificationProvider = ({ children }) => {
  const [notifications, setNotifications] = useState([]);

  const addNotification = (type, content) : string => {
    const id = uuidv4();  // Generate a UUID for each new notification

    setNotifications(prev => [...prev, {
      id: id,
      type: type,
      content: content,
      date: new Date().getTime(),
      dismissible: true,
      dismissLabel: "Hide notification",
      onDismiss: () => removeNotification(id)
    }]);    
    console.log("Added notification", id);
    return id;
  };

  const removeNotification = (id) => {
    setNotifications(prev => {
      const updatedNotifications = prev.filter(notif => notif.id !== id);
      console.log("Removing notification", id);
      console.log("Updated notifications", updatedNotifications);
      return updatedNotifications;
    });
  };

  return (
    <NotificationContext.Provider value={{ notifications, addNotification, removeNotification }}>
      {children}
    </NotificationContext.Provider>
  );
};

// eslint-disable-next-line react-refresh/only-export-components -- convenience hook over NotificationContext; splitting it into its own file would churn every consumer import
export const useNotifications = () => useContext(NotificationContext);
