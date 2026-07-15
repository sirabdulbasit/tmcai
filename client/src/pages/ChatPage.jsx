import { useEffect, useState } from 'react';
import useChat from '../hooks/useChat';
import IconRail from '../components/IconRail';
import HistorySidebar from '../components/HistorySidebar';
import MessageList from '../components/MessageList';
import ChatInput from '../components/ChatInput';
import ArtifactPanel from '../components/ArtifactPanel';

/**
 * ChatPage — chat UI. When rendered inside SteeringWheelPage (the new shell),
 * pass `embedded` to suppress the legacy IconRail + HistorySidebar chrome
 * (the new Rail lives in SteeringWheelPage).
 */
export default function ChatPage({ embedded = false }) {
  const {
    messages, isStreaming, statusText,
    selectedProvider, setSelectedProvider,
    sendMessage, stopGenerating, newChat,
    clarification, sendWithClarification, dismissClarification,
    conversationId, conversations,
    loadConversations, loadConversation, archiveConversation,
    sources, setSources,
  } = useChat();

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [welcomeLoading, setWelcomeLoading] = useState(messages.length === 0);
  const [artifact, setArtifact] = useState(null);

  useEffect(() => { loadConversations(); }, [loadConversations]);

  const handleNewChat = () => { newChat(); setSidebarOpen(false); setArtifact(null); };
  const handleSelectConversation = (id) => { loadConversation(id); setSidebarOpen(false); setArtifact(null); };

  const openArtifact = (type, html, title, widgetData) => {
    setArtifact({ type, html, title, widgetData });
  };

  if (embedded) {
    return (
      <>
        <HistorySidebar
          conversations={conversations}
          activeId={conversationId}
          onSelect={handleSelectConversation}
          onNew={handleNewChat}
          onDelete={archiveConversation}
          isOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
        />
        <main className="main-content embedded" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          <MessageList
            messages={messages}
            isStreaming={isStreaming}
            statusText={statusText}
            selectedProvider={selectedProvider}
            onFollowUp={sendMessage}
            onWelcomeAction={sendMessage}
            onWelcomeLoaded={() => setWelcomeLoading(false)}
            clarification={clarification}
            onClarificationSelect={sendWithClarification}
            onOpenArtifact={openArtifact}
          />
          <ChatInput
            onSend={sendMessage}
            onStop={stopGenerating}
            isStreaming={isStreaming}
            isFrozen={welcomeLoading}
            selectedProvider={selectedProvider}
            onProviderChange={setSelectedProvider}
            sources={sources}
            onSourcesChange={setSources}
          />
          <ArtifactPanel artifact={artifact} onClose={() => setArtifact(null)} />
        </main>
      </>
    );
  }

  return (
    <div className="app-layout">
      <IconRail onNewChat={handleNewChat} onToggleHistory={() => setSidebarOpen(o => !o)} />
      <HistorySidebar
        conversations={conversations}
        activeId={conversationId}
        onSelect={handleSelectConversation}
        onNew={handleNewChat}
        onDelete={archiveConversation}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      <main className="main-content">
        <MessageList
          messages={messages}
          isStreaming={isStreaming}
          statusText={statusText}
          selectedProvider={selectedProvider}
          onFollowUp={sendMessage}
          onWelcomeAction={sendMessage}
          onWelcomeLoaded={() => setWelcomeLoading(false)}
          clarification={clarification}
          onClarificationSelect={sendWithClarification}
          onOpenArtifact={openArtifact}
        />
        <ChatInput
          onSend={sendMessage}
          onStop={stopGenerating}
          isStreaming={isStreaming}
          isFrozen={welcomeLoading}
          selectedProvider={selectedProvider}
          onProviderChange={setSelectedProvider}
          sources={sources}
          onSourcesChange={setSources}
        />
      </main>
      <ArtifactPanel artifact={artifact} onClose={() => setArtifact(null)} />
    </div>
  );
}
