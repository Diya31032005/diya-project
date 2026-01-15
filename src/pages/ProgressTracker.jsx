import { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { subscribeToUserSyllabus, saveUserSyllabus } from '../lib/db';
import { formatDistanceToNow, format, differenceInDays } from 'date-fns';
import { Clock, BookOpen, AlertCircle, CheckCircle, Search, ChevronRight, ChevronDown, Calendar, Settings, Trash2, RotateCcw, Target, Filter, TrendingUp, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import toast from '../components/ui/Toast';
import { ConfirmDialog, useConfirmDialog } from '../components/ui/ConfirmDialog';

export default function ProgressTracker() {
    const { user } = useAuth();
    const [syllabusData, setSyllabusData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');
    const [expandedSubjects, setExpandedSubjects] = useState({});
    const [filterMode, setFilterMode] = useState('all'); // 'all', 'urgent', 'active'
    const { dialogProps, confirm } = useConfirmDialog();

    // Fetch syllabus data
    useEffect(() => {
        if (!user) return;
        const unsub = subscribeToUserSyllabus(user.uid, (data) => {
            setSyllabusData(data);
            setLoading(false);
        });
        return () => unsub();
    }, [user]);

    const activeSyllabus = useMemo(() => {
        if (!syllabusData?.syllabi) return null;
        let activeId = syllabusData.activeSyllabusId;

        if (!activeId) {
            const stored = localStorage.getItem('activeSyllabusId');
            if (stored && syllabusData.syllabi[stored]) activeId = stored;
        }

        if (!activeId) activeId = Object.keys(syllabusData.syllabi)[0];

        return syllabusData.syllabi[activeId] || null;
    }, [syllabusData]);

    const processedData = useMemo(() => {
        if (!activeSyllabus) return { grouped: {}, stats: { total: 0, urgent: 0, active: 0 } };

        const flattenTopics = (items, parentSubject = null) => {
            let results = [];
            items.forEach(item => {
                if (item.children && item.children.length > 0) {
                    results = [...results, ...flattenTopics(item.children, item.title)];
                } else {
                    const stats = item.stats || {
                        totalMinutes: 0,
                        lastStudied: null,
                        revisionInterval: 7,
                        needsRevision: false
                    };

                    let needsRevision = stats.needsRevision;
                    let daysSince = 0;
                    if (stats.lastStudied) {
                        daysSince = differenceInDays(new Date(), new Date(stats.lastStudied));
                        if (daysSince >= (stats.revisionInterval || 7)) {
                            needsRevision = true;
                        }
                    }

                    results.push({
                        ...item,
                        parentSubject: parentSubject || 'General',
                        stats: { ...stats, daysSince, needsRevision }
                    });
                }
            });
            return results;
        };

        const allTopics = flattenTopics(activeSyllabus.items);

        // Calculate stats
        const stats = {
            total: allTopics.length,
            urgent: allTopics.filter(t => t.stats.needsRevision).length,
            active: allTopics.filter(t => t.stats.totalMinutes > 0 && !t.stats.needsRevision).length
        };

        // Group by Subject
        const grouped = {};
        allTopics.forEach(topic => {
            // Apply filter
            if (filterMode === 'urgent' && !topic.stats.needsRevision) return;
            if (filterMode === 'active' && (topic.stats.totalMinutes === 0 || topic.stats.needsRevision)) return;

            // Apply search
            if (searchTerm) {
                const matchesTopic = topic.title.toLowerCase().includes(searchTerm.toLowerCase());
                const matchesSubject = topic.parentSubject.toLowerCase().includes(searchTerm.toLowerCase());
                if (!matchesTopic && !matchesSubject) return;
            }

            if (!grouped[topic.parentSubject]) grouped[topic.parentSubject] = [];
            grouped[topic.parentSubject].push(topic);
        });

        return { grouped, stats };
    }, [activeSyllabus, searchTerm, filterMode]);

    const handleUpdateInterval = async (topicId, newInterval) => {
        if (!syllabusData || !activeSyllabus) return;

        const newSyllabusData = JSON.parse(JSON.stringify(syllabusData));
        const activeId = newSyllabusData.activeSyllabusId || Object.keys(newSyllabusData.syllabi)[0];
        const currentSyllabus = newSyllabusData.syllabi[activeId];

        const updateRecursive = (list) => {
            return list.map(item => {
                if (item.id === topicId) {
                    if (!item.stats) item.stats = {};
                    item.stats.revisionInterval = parseInt(newInterval);
                    return item;
                }
                if (item.children) {
                    item.children = updateRecursive(item.children);
                }
                return item;
            });
        };

        currentSyllabus.items = updateRecursive(currentSyllabus.items);

        const success = await saveUserSyllabus(user.uid, newSyllabusData);
        if (success) toast.success('Revision schedule updated ⚙️');
        else toast.error('Failed to update schedule');
    };

    const handleMarkRevised = async (topicId) => {
        if (!syllabusData || !activeSyllabus) return;
        const newSyllabusData = JSON.parse(JSON.stringify(syllabusData));
        const activeId = newSyllabusData.activeSyllabusId || Object.keys(newSyllabusData.syllabi)[0];
        const currentSyllabus = newSyllabusData.syllabi[activeId];

        const updateRecursive = (list) => {
            return list.map(item => {
                if (item.id === topicId) {
                    if (!item.stats) item.stats = {};
                    item.stats.lastStudied = new Date().toISOString();
                    item.stats.needsRevision = false;
                    return item;
                }
                if (item.children) {
                    item.children = updateRecursive(item.children);
                }
                return item;
            });
        };

        currentSyllabus.items = updateRecursive(currentSyllabus.items);

        const success = await saveUserSyllabus(user.uid, newSyllabusData);
        if (success) toast.success('Marked as revised! Cycle reset 🔄');
        else toast.error('Failed to update status');
    };

    const handleDeleteTopic = async (topicId, topicTitle) => {
        const isConfirmed = await confirm({
            title: 'Delete Topic',
            message: `Are you sure you want to delete "${topicTitle}"? This will remove it from your syllabus and revision tracker.`,
            confirmText: 'Delete',
            isDangerous: true
        });

        if (!isConfirmed) return;

        if (!syllabusData || !activeSyllabus) return;
        const newSyllabusData = JSON.parse(JSON.stringify(syllabusData));
        const activeId = newSyllabusData.activeSyllabusId || Object.keys(newSyllabusData.syllabi)[0];
        const currentSyllabus = newSyllabusData.syllabi[activeId];

        const removeRecursive = (list) => {
            return list.filter(item => {
                if (item.id === topicId) return false;
                if (item.children) {
                    item.children = removeRecursive(item.children);
                }
                return true;
            });
        };

        currentSyllabus.items = removeRecursive(currentSyllabus.items);

        const success = await saveUserSyllabus(user.uid, newSyllabusData);
        if (success) toast.success('Topic deleted');
        else toast.error('Failed to delete topic');
    };

    const toggleSubject = (subject) => {
        setExpandedSubjects(prev => ({
            ...prev,
            [subject]: !prev[subject]
        }));
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center h-96">
                <div className="text-center">
                    <div className="w-12 h-12 border-4 border-black/20 dark:border-white/20 border-t-black dark:border-t-white rounded-full animate-spin mx-auto mb-4"></div>
                    <p className="text-[#71717A] font-light">Loading revision data...</p>
                </div>
            </div>
        );
    }

    return (
        <div className="max-w-6xl mx-auto space-y-6 animate-fade-in pb-20">
            {/* Header */}
            <motion.div
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex flex-col md:flex-row md:items-center justify-between gap-4"
            >
                <div>
                    <h1 className="text-3xl font-medium">Revision <span className="font-bold bg-gradient-to-r from-black to-black/60 dark:from-white dark:to-white/60 bg-clip-text text-transparent">Manager</span></h1>
                    <p className="text-[#71717A] font-light mt-1">Master your topics with intelligent revision scheduling</p>
                </div>

                <div className="relative w-full md:w-72">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#71717A]" />
                    <input
                        type="text"
                        placeholder="Search topics..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="w-full pl-9 pr-10 py-2.5 bg-white dark:bg-black/20 border border-black/10 dark:border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-black/20 dark:focus:ring-white/20 transition-all text-sm"
                    />
                    {searchTerm && (
                        <button
                            onClick={() => setSearchTerm('')}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-[#71717A] hover:text-black dark:hover:text-white transition-colors"
                        >
                            <X className="w-4 h-4" />
                        </button>
                    )}
                </div>
            </motion.div>

            {/* Filter Tabs */}
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.1 }}
                className="flex gap-2 p-1 bg-black/5 dark:bg-white/5 rounded-lg w-fit"
            >
                {[
                    { key: 'all', label: 'All Topics', icon: BookOpen },
                    { key: 'urgent', label: 'Needs Revision', icon: AlertCircle },
                    { key: 'active', label: 'Active', icon: TrendingUp }
                ].map(({ key, label, icon: Icon }) => (
                    <button
                        key={key}
                        onClick={() => setFilterMode(key)}
                        className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all ${filterMode === key
                                ? 'bg-black dark:bg-white text-white dark:text-black shadow-sm'
                                : 'text-[#71717A] hover:text-black dark:hover:text-white'
                            }`}
                    >
                        <Icon className="w-4 h-4" />
                        {label}
                    </button>
                ))}
            </motion.div>

            {/* Enhanced Stats Cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.2 }}
                    className="relative overflow-hidden card p-6 bg-gradient-to-br from-yellow-50 to-orange-50 dark:from-yellow-900/10 dark:to-orange-900/10 border-yellow-200 dark:border-yellow-700/30"
                >
                    <div className="absolute top-0 right-0 w-32 h-32 bg-yellow-400/10 dark:bg-yellow-400/5 rounded-full -mr-16 -mt-16"></div>
                    <div className="relative">
                        <div className="flex items-center gap-2 text-yellow-700 dark:text-yellow-400 mb-3">
                            <AlertCircle className="w-6 h-6" />
                            <h3 className="font-bold text-sm uppercase tracking-wider">Needs Revision</h3>
                        </div>
                        <p className="text-4xl font-bold mb-2 text-yellow-800 dark:text-yellow-300">
                            {processedData.stats.urgent}
                        </p>
                        <p className="text-sm text-yellow-600/80 dark:text-yellow-400/60 font-light">Topics require attention</p>
                        <div className="mt-3 h-1.5 bg-yellow-200/50 dark:bg-yellow-800/30 rounded-full overflow-hidden">
                            <motion.div
                                initial={{ width: 0 }}
                                animate={{ width: `${(processedData.stats.urgent / processedData.stats.total) * 100}%` }}
                                transition={{ duration: 1, ease: "easeOut" }}
                                className="h-full bg-yellow-500 dark:bg-yellow-400"
                            />
                        </div>
                    </div>
                </motion.div>

                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.3 }}
                    className="relative overflow-hidden card p-6 bg-gradient-to-br from-green-50 to-emerald-50 dark:from-green-900/10 dark:to-emerald-900/10 border-green-200 dark:border-green-700/30"
                >
                    <div className="absolute top-0 right-0 w-32 h-32 bg-green-400/10 dark:bg-green-400/5 rounded-full -mr-16 -mt-16"></div>
                    <div className="relative">
                        <div className="flex items-center gap-2 text-green-700 dark:text-green-400 mb-3">
                            <CheckCircle className="w-6 h-6" />
                            <h3 className="font-bold text-sm uppercase tracking-wider">Active Topics</h3>
                        </div>
                        <p className="text-4xl font-bold mb-2 text-green-800 dark:text-green-300">
                            {processedData.stats.active}
                        </p>
                        <p className="text-sm text-green-600/80 dark:text-green-400/60 font-light">Studied recently</p>
                        <div className="mt-3 h-1.5 bg-green-200/50 dark:bg-green-800/30 rounded-full overflow-hidden">
                            <motion.div
                                initial={{ width: 0 }}
                                animate={{ width: `${(processedData.stats.active / processedData.stats.total) * 100}%` }}
                                transition={{ duration: 1, ease: "easeOut", delay: 0.1 }}
                                className="h-full bg-green-500 dark:bg-green-400"
                            />
                        </div>
                    </div>
                </motion.div>

                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.4 }}
                    className="relative overflow-hidden card p-6 bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-900/10 dark:to-indigo-900/10 border-blue-200 dark:border-blue-700/30"
                >
                    <div className="absolute top-0 right-0 w-32 h-32 bg-blue-400/10 dark:bg-blue-400/5 rounded-full -mr-16 -mt-16"></div>
                    <div className="relative">
                        <div className="flex items-center gap-2 text-blue-700 dark:text-blue-400 mb-3">
                            <Clock className="w-6 h-6" />
                            <h3 className="font-bold text-sm uppercase tracking-wider">Total Study Time</h3>
                        </div>
                        <p className="text-4xl font-bold mb-2 text-blue-800 dark:text-blue-300">
                            {Math.round(Object.values(processedData.grouped).flat().reduce((acc, t) => acc + (t.stats.totalMinutes || 0), 0) / 60)}h
                        </p>
                        <p className="text-sm text-blue-600/80 dark:text-blue-400/60 font-light">Across all topics</p>
                        <div className="mt-3 flex items-center gap-2 text-xs text-blue-600/70 dark:text-blue-400/70">
                            <Target className="w-3 h-3" />
                            <span>{processedData.stats.total} topics tracked</span>
                        </div>
                    </div>
                </motion.div>
            </div>

            {/* Main Content */}
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.5 }}
                className="space-y-3"
            >
                {Object.keys(processedData.grouped).length === 0 ? (
                    <div className="text-center py-20 card">
                        <BookOpen className="w-16 h-16 mx-auto mb-4 text-[#71717A]/30" />
                        <p className="text-[#71717A] font-light">
                            {filterMode === 'urgent' ? 'No topics need revision right now! 🎉' :
                                filterMode === 'active' ? 'No active topics found. Start studying!' :
                                    'No topics found. Start logging your study sessions!'}
                        </p>
                    </div>
                ) : (
                    Object.entries(processedData.grouped).map(([subject, topics], index) => (
                        <motion.div
                            key={subject}
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.1 * index }}
                            className="card overflow-hidden hover:shadow-lg transition-shadow duration-300"
                        >
                            <button
                                onClick={() => toggleSubject(subject)}
                                className="w-full flex items-center justify-between p-5 bg-gradient-to-r from-black/[0.03] to-transparent dark:from-white/[0.03] dark:to-transparent hover:from-black/[0.06] dark:hover:from-white/[0.06] transition-all duration-300"
                            >
                                <div className="flex items-center gap-3">
                                    <div className={`w-1 h-8 rounded-full ${topics.some(t => t.stats.needsRevision)
                                            ? 'bg-yellow-500'
                                            : 'bg-green-500'
                                        }`}></div>
                                    <span className="font-bold text-lg">{subject}</span>
                                    <span className="text-xs bg-black/10 dark:bg-white/10 px-3 py-1 rounded-full text-[#71717A] font-medium">
                                        {topics.length}
                                    </span>
                                    {topics.some(t => t.stats.needsRevision) && (
                                        <span className="text-xs bg-yellow-100 dark:bg-yellow-900/40 text-yellow-800 dark:text-yellow-300 px-2 py-1 rounded-full flex items-center gap-1 font-medium">
                                            <AlertCircle className="w-3 h-3" />
                                            {topics.filter(t => t.stats.needsRevision).length} Urgent
                                        </span>
                                    )}
                                </div>
                                <motion.div
                                    animate={{ rotate: expandedSubjects[subject] ? 180 : 0 }}
                                    transition={{ duration: 0.3 }}
                                >
                                    <ChevronDown className="w-5 h-5 text-[#71717A]" />
                                </motion.div>
                            </button>

                            <AnimatePresence>
                                {expandedSubjects[subject] && (
                                    <motion.div
                                        initial={{ height: 0, opacity: 0 }}
                                        animate={{ height: 'auto', opacity: 1 }}
                                        exit={{ height: 0, opacity: 0 }}
                                        transition={{ duration: 0.3 }}
                                    >
                                        <div className="divide-y divide-black/5 dark:divide-white/5">
                                            {topics.map((topic, idx) => (
                                                <motion.div
                                                    key={topic.id}
                                                    initial={{ opacity: 0, x: -20 }}
                                                    animate={{ opacity: 1, x: 0 }}
                                                    transition={{ delay: idx * 0.05 }}
                                                    className="p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4 hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors group"
                                                >
                                                    <div className="flex-1 min-w-0">
                                                        <div className="flex items-center gap-2 mb-2">
                                                            <h4 className="font-semibold text-base truncate">{topic.title}</h4>
                                                            {topic.stats.needsRevision && (
                                                                <motion.span
                                                                    initial={{ scale: 0 }}
                                                                    animate={{ scale: 1 }}
                                                                    className="text-[10px] font-bold text-yellow-700 bg-yellow-100 dark:bg-yellow-900/40 dark:text-yellow-300 px-2 py-1 rounded uppercase tracking-wider whitespace-nowrap"
                                                                >
                                                                    Revise Now
                                                                </motion.span>
                                                            )}
                                                        </div>
                                                        <div className="text-sm text-[#71717A] flex flex-wrap gap-x-4 gap-y-1">
                                                            <span className="flex items-center gap-1.5">
                                                                <Clock className="w-3.5 h-3.5" />
                                                                <span className="font-medium">
                                                                    {topic.stats.totalMinutes < 60
                                                                        ? `${topic.stats.totalMinutes}m`
                                                                        : `${(topic.stats.totalMinutes / 60).toFixed(1)}h`
                                                                    }
                                                                </span>
                                                                <span className="opacity-60">studied</span>
                                                            </span>
                                                            <span className="flex items-center gap-1.5">
                                                                <Calendar className="w-3.5 h-3.5" />
                                                                {topic.stats.lastStudied ? (
                                                                    <>
                                                                        <span className="font-medium">{formatDistanceToNow(new Date(topic.stats.lastStudied))}</span>
                                                                        <span className="opacity-60">ago</span>
                                                                    </>
                                                                ) : (
                                                                    <span className="opacity-60">Never studied</span>
                                                                )}
                                                            </span>
                                                        </div>

                                                        {/* Progress bar for study time */}
                                                        <div className="mt-2 h-1 bg-black/5 dark:bg-white/10 rounded-full overflow-hidden">
                                                            <motion.div
                                                                initial={{ width: 0 }}
                                                                animate={{ width: `${Math.min((topic.stats.totalMinutes / 60) * 10, 100)}%` }}
                                                                transition={{ duration: 0.8, delay: idx * 0.05 }}
                                                                className={`h-full ${topic.stats.needsRevision
                                                                        ? 'bg-yellow-500'
                                                                        : 'bg-green-500'
                                                                    }`}
                                                            />
                                                        </div>
                                                    </div>

                                                    <div className="flex items-center gap-3 lg:gap-4">
                                                        <div className="flex flex-col items-end min-w-[140px]">
                                                            <label className="text-[10px] text-[#71717A] uppercase tracking-wider font-semibold mb-1.5 flex items-center gap-1">
                                                                <Settings className="w-3 h-3" /> Cycle
                                                            </label>
                                                            <select
                                                                value={topic.stats.revisionInterval || 7}
                                                                onChange={(e) => handleUpdateInterval(topic.id, e.target.value)}
                                                                className="w-full text-sm bg-white dark:bg-black/20 border border-black/10 dark:border-white/10 rounded-lg px-3 py-1.5 outline-none focus:ring-2 focus:ring-black/20 dark:focus:ring-white/20 transition-all cursor-pointer hover:border-black dark:hover:border-white font-medium"
                                                            >
                                                                <option value="1">Daily (1d)</option>
                                                                <option value="3">Every 3 Days</option>
                                                                <option value="7">Weekly (7d)</option>
                                                                <option value="14">Bi-Weekly (14d)</option>
                                                                <option value="30">Monthly (30d)</option>
                                                            </select>
                                                        </div>

                                                        <div className="flex items-center gap-2">
                                                            {topic.stats.needsRevision && (
                                                                <motion.button
                                                                    whileHover={{ scale: 1.05 }}
                                                                    whileTap={{ scale: 0.95 }}
                                                                    onClick={() => handleMarkRevised(topic.id)}
                                                                    className="p-2.5 bg-green-500 hover:bg-green-600 text-white rounded-lg transition-colors shadow-md hover:shadow-lg"
                                                                    title="Mark as Revised"
                                                                >
                                                                    <RotateCcw className="w-4 h-4" />
                                                                </motion.button>
                                                            )}
                                                            <motion.button
                                                                whileHover={{ scale: 1.05 }}
                                                                whileTap={{ scale: 0.95 }}
                                                                onClick={() => handleDeleteTopic(topic.id, topic.title)}
                                                                className="p-2.5 text-[#71717A] hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-500 rounded-lg transition-colors"
                                                                title="Delete Topic"
                                                            >
                                                                <Trash2 className="w-4 h-4" />
                                                            </motion.button>
                                                        </div>
                                                    </div>
                                                </motion.div>
                                            ))}
                                        </div>
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </motion.div>
                    ))
                )}
            </motion.div>
            <ConfirmDialog {...dialogProps} />
        </div>
    );
}
