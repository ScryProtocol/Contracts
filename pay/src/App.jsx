import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Coins, 
  Flame, 
  ShieldCheck, 
  TrendingUp, 
  Users, 
  Wallet, 
  ExternalLink,
  ChevronRight,
  AlertCircle,
  Trophy
} from 'lucide-react';

// --- Constants & Mock Data ---
const GOAL_ETH = 1500;

const App = () => {
  const [currentRaised, setCurrentRaised] = useState(442.65);
  const [contribution, setContribution] = useState("1.5");
  const [isWalletConnected, setIsWalletConnected] = useState(false);
  const [activeTab, setActiveTab] = useState('mint'); // 'mint' | 'dao' | 'withdraw'
  const [showSuccess, setShowSuccess] = useState(false);

  const progress = (currentRaised / GOAL_ETH) * 100;
  const isFilled = currentRaised >= GOAL_ETH;

  const handleContribute = () => {
    if (!isWalletConnected) return;
    const amount = parseFloat(contribution);
    if (isNaN(amount)) return;
    
    // Simulate transaction
    setTimeout(() => {
      setCurrentRaised(prev => prev + amount);
      setShowSuccess(true);
      setTimeout(() => setShowSuccess(false), 4000);
    }, 800);
  };

  return (
    <div className="min-h-screen bg-[#FFDE00] text-black font-mono selection:bg-black selection:text-white p-4 md:p-8">
      {/* Header */}
      <header className="max-w-6xl mx-auto flex flex-col md:flex-row justify-between items-center mb-12 gap-6">
        <div className="flex items-center gap-3 bg-white border-4 border-black p-3 shadow-[4px_4px_0_0_#000]">
          <div className="bg-[#FF007F] p-2 border-2 border-black">
            <Coins size={32} color="white" />
          </div>
          <h1 className="text-3xl font-black italic tracking-tighter uppercase">pay.eth DAO</h1>
        </div>

        <button 
          onClick={() => setIsWalletConnected(!isWalletConnected)}
          className={`flex items-center gap-2 px-6 py-3 border-4 border-black font-black uppercase text-lg shadow-[6px_6px_0_0_#000] transition-all active:translate-x-1 active:translate-y-1 active:shadow-none ${
            isWalletConnected ? 'bg-[#00F5FF]' : 'bg-white hover:bg-[#00F5FF]'
          }`}
        >
          <Wallet size={20} />
          {isWalletConnected ? '0x71C...3A92' : 'Connect Wallet'}
        </button>
      </header>

      <main className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-8">
        
        {/* Left Column: NFT Preview & Stats */}
        <section className="lg:col-span-5 space-y-8">
          <div className="bg-white border-4 border-black shadow-[8px_8px_0_0_#000] overflow-hidden">
            <div className="relative aspect-square border-b-4 border-black">
<svg viewBox="0 0 200 200" className="w-full h-full">

              <svg viewBox="0 0 200 200" className="w-full h-full" xmlns="http://www.w3.org/2000/svg">
                <defs>
                  <style>
                    {`
                      .brutal-float { animation: brutal-float-anim 4s ease-in-out infinite; transform-origin: center; }
                      .brutal-spin { animation: brutal-spin-anim 12s linear infinite; transform-origin: 165px 40px; }
                      .brutal-pulse { animation: brutal-pulse-anim 1.5s ease-in-out infinite alternate; transform-origin: 30px 140px; }
                      
                      @keyframes brutal-float-anim {
                        0%, 100% { transform: translateY(0px); }
                        50% { transform: translateY(-15px); }
                      }
                      @keyframes brutal-spin-anim {
                        100% { transform: rotate(360deg); }
                      }
                      @keyframes brutal-pulse-anim {
                        0% { transform: scale(1) rotate(-15deg); }
                        100% { transform: scale(1.1) rotate(5deg); }
                      }
                    `}
                  </style>
                  <pattern id="brutal-grid" width="20" height="20" patternUnits="userSpaceOnUse">
                    <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#000" strokeWidth="2" opacity="0.1" />
                  </pattern>
                </defs>

                <rect width="200" height="200" fill="url(#brutal-grid)" />

                {/* Ticker Tape */}
                <g transform="rotate(-5 100 185)">
                  <rect x="-50" y="165" width="300" height="30" fill="#000" />
                  <text x="25" y="186" fontFamily="monospace" fontWeight="900" fontSize="14" fill="#FFDE00" letterSpacing="1">
                    PAY.ETH • {isFilled ? 'GOAL REACHED' : 'MINT LIVE'}
                  </text>
                </g>

                {/* Spinning Star */}
                <g className="brutal-spin">
                    <polygon points="169,19 174,34 189,39 174,44 169,59 164,44 149,39 164,34" fill="#000" />
                    <polygon points="165,15 170,30 185,35 170,40 165,55 160,40 145,35 160,30" fill={isFilled ? "#FFDE00" : "#00F5FF"} stroke="#000" strokeWidth="3" />
                </g>

                {/* Abstract Block */}
                <g className="brutal-pulse">
                    <rect x="19" y="129" width="24" height="24" fill="#000" />
                    <rect x="15" y="125" width="24" height="24" fill={isFilled ? "#FFDE00" : "#FF007F"} stroke="#000" strokeWidth="3" />
                </g>

                {/* Floating Crystal */}
                <g className="brutal-float">
                  <polygon points="108,46 148,96 108,136 68,96" fill="#000" />
                  <polygon points="108,144 148,114 108,184 68,114" fill="#000" />

                  {/* Top Crystal */}
                  <polygon points="100,40 140,90 100,130" fill={isFilled ? "#FFDE00" : "#00F5FF"} stroke="#000" strokeWidth="4" />
                  <polygon points="100,40 60,90 100,130" fill="#FFFFFF" stroke="#000" strokeWidth="4" />
                  
                  {/* Bottom Crystal */}
                  <polygon points="100,138 140,108 100,178" fill={isFilled ? "#FFDE00" : "#FF007F"} stroke="#000" strokeWidth="4" />
                  <polygon points="100,138 60,108 100,178" fill={isFilled ? "#FFFFFF" : "#FFDE00"} stroke="#000" strokeWidth="4" />
                  
                  <line x1="100" y1="40" x2="100" y2="130" stroke="#000" strokeWidth="4" />
                  <line x1="100" y1="138" x2="100" y2="178" stroke="#000" strokeWidth="4" />
                  <line x1="60" y1="90" x2="140" y2="90" stroke="#000" strokeWidth="4" />
                </g>
              </svg>
</svg>
              <div className="absolute top-4 left-4 bg-black text-white px-3 py-1 font-bold text-sm uppercase">
                PAY.ETH
              </div>
            </div>
            <div className="p-6 space-y-4">
              <div className="flex justify-between items-end">
                <div>
                  <p className="text-xs font-bold uppercase opacity-60">Status</p>
                  <p className="text-2xl font-black uppercase flex items-center gap-2">
                    {isFilled ? 'Filled' : 'Live Sale'} 
                    {!isFilled && <span className="inline-block w-3 h-3 bg-red-500 rounded-full animate-pulse" />}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-xs font-bold uppercase opacity-60">Total Shares</p>
                  <p className="text-2xl font-black">1,000,000 $PAY</p>
                </div>
              </div>
              
              <div className="bg-[#00F5FF] border-2 border-black p-3 flex items-center gap-3">
                <ShieldCheck size={24} />
                <p className="text-sm font-bold">100% Withdrawal if Goal Missed</p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <StatCard label="Contributors" value="1,248" icon={<Users size={20} />} color="#FF007F" />
            <StatCard label="End Date" value="2d 14h" icon={<Flame size={20} />} color="#FFDE00" />
          </div>
        </section>

        {/* Right Column: Interaction Panel */}
        <section className="lg:col-span-7">
          <div className="bg-white border-4 border-black shadow-[12px_12px_0_0_#000] flex flex-col h-full">
            
            {/* Tabs */}
            <div className="flex border-b-4 border-black">
              <TabButton active={activeTab === 'mint'} onClick={() => setActiveTab('mint')}>Fund DAO</TabButton>
              <TabButton active={activeTab === 'dao'} onClick={() => setActiveTab('dao')}>Governance</TabButton>
              <TabButton active={activeTab === 'withdraw'} onClick={() => setActiveTab('withdraw')}>Withdrawal</TabButton>
            </div>

            <div className="p-8 flex-grow">
              {activeTab === 'mint' && (
                <div className="space-y-8">
                  <div>
                    <div className="flex justify-between mb-4 items-end">
                      <h2 className="text-4xl font-black uppercase italic">Progress</h2>
                      <span className="text-xl font-black">{currentRaised.toLocaleString()} / 1,500 ETH</span>
                    </div>
                    {/* Progress Bar */}
                    <div className="h-12 w-full bg-black p-1 border-4 border-black">
                      <div className="h-full bg-white relative overflow-hidden">
                        <motion.div 
                          initial={{ width: 0 }}
                          animate={{ width: `${progress}%` }}
                          className="h-full bg-[#FF007F] border-r-4 border-black"
                        />
                        <div className="absolute inset-0 flex items-center justify-center font-black mix-blend-difference text-white">
                          {progress.toFixed(1)}% COMPLETE
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="bg-[#f0f0f0] border-4 border-black p-6 space-y-4">
                    <label className="block text-lg font-black uppercase">Contribute ETH</label>
                    <div className="flex gap-4">
                      <div className="relative flex-grow">
                        <input 
                          type="number" 
                          value={contribution}
                          onChange={(e) => setContribution(e.target.value)}
                          className="w-full bg-white border-4 border-black p-4 text-2xl font-black focus:outline-none focus:bg-[#00F5FF]"
                        />
                        <span className="absolute right-4 top-1/2 -translate-y-1/2 font-black text-xl">ETH</span>
                      </div>
                      <button 
                        onClick={handleContribute}
                        disabled={!isWalletConnected}
                        className="bg-black text-white px-8 font-black uppercase text-xl hover:bg-[#FF007F] transition-colors disabled:opacity-30"
                      >
                        Contribute
                      </button>
                    </div>
                    <p className="text-xs font-bold text-gray-600 italic">
                      * If the 1,500 ETH goal isn't met, you can withdraw 100% of your funds.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-4">
                    <FeatureBox title="DAO Votes" desc="Vote on governance proposals, partnerships, and more once the goal is reached" />
                    <FeatureBox title="Fragmented Ownership" desc="Own a piece of pay.eth. The most valuable domain in crypto should be community owned." />
                    <div className="border-4 border-black p-3 flex items-start gap-2 bg-white">
    <ChevronRight size={20} className="mt-1 shrink-0" />
    <div>
      <p className="font-black uppercase text-sm leading-tight">State Channel</p>
      <p className="text-xs font-bold text-gray-500">Contributors will be airdropped 20% of the State Channel Protocol tokens as part of the DAO launch.</p>
    <a href="http://statechannel.org/" target="_blank" className="mt-2 text-xs font-bold text-[#FF007F] hover:underline">check out</a>
    </div>
  </div>
  <FeatureBox title="Safety Hatch" desc="If the funding goal isn't met, contributors can withdraw their ETH directly from the contract with no fees." />
  </div>
<div className="text-center">
  <p className="text-xs">* Funds raised in this sale are intended for the purchase of the pay.eth domain and not treasury to let me keep building dope open source shit. The DAO treasury can be funded through future proposals and sale of pay.eth</p>
</div>
                </div>
              )}

              {activeTab === 'dao' && (
                <div className="h-full flex flex-col items-center justify-center text-center space-y-4 py-12">
                  <div className="bg-black p-6 rounded-full text-[#FFDE00]">
                    <Trophy size={64} />
                  </div>
                  <h3 className="text-3xl font-black uppercase">Governance Locked</h3>
                  <p className="max-w-xs font-bold">Voting and proposals will activate once the 1,500 ETH goal is reached.</p>
                </div>
              )}

              {activeTab === 'withdraw' && (
                <div className="space-y-6">
                  <div className="bg-red-100 border-4 border-black p-6 flex gap-4">
                    <AlertCircle size={48} className="shrink-0" />
                    <div>
                      <h3 className="text-xl font-black uppercase">Safety Hatch</h3>
                      <p className="font-bold">In "Fill or Kill" mode, if the target is missed, contributors can claw back their ETH directly from the contract.</p>
                    </div>
                  </div>
                  <button className="w-full py-6 bg-white border-4 border-black shadow-[4px_4px_0_0_#000] font-black uppercase text-xl opacity-50 cursor-not-allowed">
                    Withdrawal Unavailable (Sale Active)
                  </button>
                </div>
              )}
            </div>
            {/* Footer Status */}
            <div className="bg-black text-[#00F5FF] p-4 flex justify-between items-center px-8 font-bold text-sm">
              <div className="flex items-center gap-2">
                <TrendingUp size={16} />
                <span>GAS: 14 GWEI</span>
              </div>
              <div className="flex items-center gap-4">
                <a href="#" className="hover:underline flex items-center gap-1 uppercase">Etherscan <ExternalLink size={14}/></a>
                <span className="opacity-40">|</span>
                <span>V1.0.4-HOTFIX</span>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* Success Notification Overlay */}
      <AnimatePresence>
        {showSuccess && (
          <motion.div 
            initial={{ y: 100, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 100, opacity: 0 }}
            className="fixed bottom-8 left-1/2 -translate-x-1/2 z-50"
          >
            <div className="bg-[#00F5FF] border-4 border-black p-6 shadow-[8px_8px_0_0_#000] flex items-center gap-4">
              <div className="bg-black p-2 rounded-full">
                <Trophy size={24} color="#00F5FF" />
              </div>
              <div>
                <p className="font-black uppercase text-lg">Transaction Sent!</p>
                <p className="font-bold text-sm">Welcome to the pay.eth DAO.</p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <footer className="mt-20 text-center border-t-4 border-black pt-8 pb-12">
        <p className="text-xl font-black italic tracking-widest uppercase">pay.eth DAO</p>
        <p className="text-sm font-bold text-gray-600">A community-owned DAO for collective ownership of the pay.eth domain</p>
      </footer>
    </div>
  );
};

// --- Sub-components ---

const TabButton = ({ children, active, onClick }) => (
  <button 
    onClick={onClick}
    className={`flex-1 py-4 font-black uppercase text-lg border-r-4 last:border-r-0 border-black transition-colors ${
      active ? 'bg-black text-white' : 'bg-white hover:bg-gray-100'
    }`}
  >
    {children}
  </button>
);

const StatCard = ({ label, value, icon, color }) => (
  <div className="bg-white border-4 border-black p-4 shadow-[4px_4px_0_0_#000] flex flex-col gap-2">
    <div className="flex items-center gap-2 font-black uppercase text-xs">
      <div style={{ backgroundColor: color }} className="p-1 border-2 border-black">
        {icon}
      </div>
      {label}
    </div>
    <div className="text-2xl font-black tracking-tight">{value}</div>
  </div>
);

const FeatureBox = ({ title, desc }) => (
  <div className="border-4 border-black p-3 flex items-start gap-2 bg-white">
    <ChevronRight size={20} className="mt-1 shrink-0" />
    <div>
      <p className="font-black uppercase text-sm leading-tight">{title}</p>
      <p className="text-xs font-bold text-gray-500">{desc}</p>
    </div>
  </div>
);

export default App;
