import { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { subscribeToRecentLogs, subscribeToUserStats, subscribeToQuizResults, subscribeToUserSyllabus } from '../lib/db';
import {
    BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
    LineChart, Line, PieChart, Pie, Cell, AreaChart, Area, RadarChart, Radar,
    PolarGrid, PolarAngleAxis, PolarRadiusAxis, ComposedChart
} from 'recharts';
import {
    BarChart3, TrendingUp, Download, Calendar, Clock, Flame, Target,
    PieChartIcon, BookOpen, Award, Zap, Activity, FileText, Brain,
    CheckCircle, AlertCircle, ArrowUp, ArrowDown
} from 'lucide-react';
import {
    format, parseISO, subDays, startOfYear, isAfter, startOfWeek, endOfWeek,
    eachDayOfInterval, isSameDay, subWeeks, startOfMonth, endOfMonth, differenceInDays
} from 'date-fns';
import { jsPDF } from 'jspdf';
import 'jspdf-autotable';
import { motion, AnimatePresence } from 'framer-motion';

// Palette for dynamic papers
const COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#06B6D4', '#F43F5E', '#14B8A6', '#6366F1'];

const getInitials = (name) => {
    return name.split(' ').map(n => n[0]).join('').substring(0, 3).toUpperCase();
};

export default function Analytics() {
    const { user } = useAuth();
    const [logs, setLogs] = useState([]);
    const [quizResults, setQuizResults] = useState([]);
    const [userStats, setUserStats] = useState(null);
    const [syllabusData, setSyllabusData] = useState(null);
    const [timeRange, setTimeRange] = useState('30d');
    const [activeTab, setActiveTab] = useState('overview');

    useEffect(() => {
        if (!user) return;
        const unsubLogs = subscribeToRecentLogs(user.uid, 1000, (data) => setLogs(data));
        const unsubQuiz = subscribeToQuizResults(user.uid, 100, (data) => setQuizResults(data));
        const unsubStats = subscribeToUserStats(user.uid, (data) => setUserStats(data));
        const unsubSyllabus = subscribeToUserSyllabus(user.uid, (data) => setSyllabusData(data));

        return () => {
            unsubLogs();
            unsubQuiz();
            unsubStats();
            unsubSyllabus?.();
        };
    }, [user]);

    // Filter Data based on Time Range
    const filteredLogs = useMemo(() => {
        const now = new Date();
        let startDate;
        switch (timeRange) {
            case '7d': startDate = subDays(now, 7); break;
            case '30d': startDate = subDays(now, 30); break;
            case '90d': startDate = subDays(now, 90); break;
            case 'year': startDate = startOfYear(now); break;
            default: startDate = null;
        }
        if (!startDate) return logs;
        return logs.filter(log => log.date && isAfter(parseISO(log.date), startDate));
    }, [logs, timeRange]);

    // ===== COMPREHENSIVE ANALYTICS =====

    // 1. Dynamic Syllabus Processing (Papers & Mapping)
    const { dynamicPapers, subjectMap } = useMemo(() => {
        if (!syllabusData || !syllabusData.syllabi) {
            return { dynamicPapers: [], subjectMap: new Map() };
        }

        // Get active syllabus (prefer Firestore data, fallback to localStorage or first available)
        const activeId = syllabusData.activeSyllabusId || localStorage.getItem('active_syllabus');
        const activeSyllabus = (activeId && syllabusData.syllabi[activeId]) || Object.values(syllabusData.syllabi)[0];

        if (!activeSyllabus || !activeSyllabus.items) {
            return { dynamicPapers: [], subjectMap: new Map() };
        }

        const map = new Map();
        const papers = activeSyllabus.items.map((item, index) => {
            // Count totals and completed
            let total = 0;
            let completed = 0;
            const completedSet = new Set(activeSyllabus.completed || []);

            const traverse = (node) => {
                total++;
                if (completedSet.has(node.id)) completed++;

                // Map this node's title to the Parent Paper ID
                map.set(node.title.toLowerCase(), item.id);

                if (node.children) node.children.forEach(traverse);
            };
            traverse(item);

            return {
                id: item.id,
                name: item.title,
                short: getInitials(item.title),
                color: COLORS[index % COLORS.length],
                total: total,
                completed: completed,
                progress: total > 0 ? Math.round((completed / total) * 100) : 0
            };
        });

        return { dynamicPapers: papers, subjectMap: map };
    }, [syllabusData]); // Depend on syllabusData from DB

    // 2. Paper-wise Hours Distribution
    const paperHours = useMemo(() => {
        if (dynamicPapers.length === 0) return [];

        const data = {};
        dynamicPapers.forEach(p => { data[p.id] = 0; });
        data['other'] = 0;

        filteredLogs.forEach(log => {
            const subjectLower = (log.subject || '').toLowerCase();
            const topicLower = (log.topic || '').toLowerCase();

            // Try to find paper ID from map
            let paperId = subjectMap.get(subjectLower) || subjectMap.get(topicLower);

            // If not found, try partial match against paper names
            if (!paperId) {
                const found = dynamicPapers.find(p =>
                    subjectLower.includes(p.name.toLowerCase()) ||
                    p.name.toLowerCase().includes(subjectLower)
                );
                if (found) paperId = found.id;
            }

            if (paperId && data[paperId] !== undefined) {
                data[paperId] += (log.durationMinutes || 0) / 60;
            } else {
                data['other'] += (log.durationMinutes || 0) / 60;
            }
        });

        // Filter out 'other' if 0 or keep it if relevant
        const result = dynamicPapers.map(p => ({
            ...p,
            hours: parseFloat((data[p.id] || 0).toFixed(1)),
            fill: p.color
        }));

        if (data['other'] > 0.5) { // Only show 'Other' if significant
            result.push({
                id: 'other',
                name: 'Other',
                short: 'OTH',
                color: '#9CA3AF',
                hours: parseFloat(data['other'].toFixed(1)),
                fill: '#9CA3AF',
                progress: 0,
                total: 0,
                completed: 0
            });
        }

        return result;
    }, [filteredLogs, dynamicPapers, subjectMap]);

    // 3. Daily/Weekly/Monthly Trends
    const trendData = useMemo(() => {
        const daysCount = timeRange === '7d' ? 7 : timeRange === '30d' ? 30 : 15;
        const daysMap = new Map();

        for (let i = daysCount - 1; i >= 0; i--) {
            const d = subDays(new Date(), i);
            daysMap.set(format(d, 'MMM d'), { date: format(d, 'MMM d'), hours: 0, sessions: 0 });
        }

        filteredLogs.forEach(log => {
            if (!log.date) return;
            const dateStr = format(parseISO(log.date), 'MMM d');
            if (daysMap.has(dateStr)) {
                const existing = daysMap.get(dateStr);
                existing.hours += (log.durationMinutes || 0) / 60;
                existing.sessions += 1;
            }
        });

        return Array.from(daysMap.values()).map(d => ({
            ...d,
            hours: parseFloat(d.hours.toFixed(1))
        }));
    }, [filteredLogs, timeRange]);

    // 4. Subject Distribution
    const subjectData = useMemo(() => {
        const data = {};
        filteredLogs.forEach(log => {
            const subject = log.subject || 'Other';
            data[subject] = (data[subject] || 0) + (log.durationMinutes || 0) / 60;
        });
        return Object.entries(data)
            .map(([name, hours]) => ({ name, hours: parseFloat(hours.toFixed(1)) }))
            .sort((a, b) => b.hours - a.hours);
    }, [filteredLogs]);

    // 5. Weekly Comparison (This week vs Last week)
    const weeklyComparison = useMemo(() => {
        const now = new Date();
        const thisWeekStart = startOfWeek(now, { weekStartsOn: 1 });
        const lastWeekStart = subWeeks(thisWeekStart, 1);
        const lastWeekEnd = subDays(thisWeekStart, 1);

        let thisWeekHours = 0;
        let lastWeekHours = 0;

        logs.forEach(log => {
            if (!log.date) return;
            const date = parseISO(log.date);
            const hours = (log.durationMinutes || 0) / 60;

            if (date >= thisWeekStart) thisWeekHours += hours;
            else if (date >= lastWeekStart && date <= lastWeekEnd) lastWeekHours += hours;
        });

        const change = lastWeekHours > 0
            ? ((thisWeekHours - lastWeekHours) / lastWeekHours * 100).toFixed(0)
            : thisWeekHours > 0 ? 100 : 0;

        return { thisWeek: thisWeekHours.toFixed(1), lastWeek: lastWeekHours.toFixed(1), change };
    }, [logs]);

    // 6. Daily Average
    const dailyAverage = useMemo(() => {
        if (filteredLogs.length === 0) return 0;
        const totalHours = filteredLogs.reduce((acc, l) => acc + (l.durationMinutes || 0) / 60, 0);
        const daysCount = timeRange === '7d' ? 7 : timeRange === '30d' ? 30 : timeRange === '90d' ? 90 : 365;
        return (totalHours / daysCount).toFixed(1);
    }, [filteredLogs, timeRange]);

    // 7. Study Session Analysis (Mode distribution: Stopwatch, Pomodoro, Manual)
    const modeDistribution = useMemo(() => {
        const modes = { stopwatch: 0, pomodoro: 0, manual: 0 };
        filteredLogs.forEach(log => {
            const mode = log.mode || 'stopwatch';
            modes[mode] = (modes[mode] || 0) + 1;
        });
        return Object.entries(modes).map(([name, count]) => ({
            name: name.charAt(0).toUpperCase() + name.slice(1),
            value: count
        }));
    }, [filteredLogs]);

    // 8. Peak Study Hours
    const peakHours = useMemo(() => {
        const hourCounts = {};
        filteredLogs.forEach(log => {
            if (!log.date) return;
            const hour = new Date(log.date).getHours();
            const hourKey = `${hour}:00`;
            hourCounts[hourKey] = (hourCounts[hourKey] || 0) + (log.durationMinutes || 0) / 60;
        });
        return Object.entries(hourCounts)
            .map(([hour, totalHours]) => ({ hour, hours: parseFloat(totalHours.toFixed(1)) }))
            .sort((a, b) => b.hours - a.hours)
            .slice(0, 5);
    }, [filteredLogs]);

    // 8. Syllabus Progress per Paper (Mapped directly from dynamicPapers)
    const syllabusProgress = useMemo(() => {
        return dynamicPapers;
    }, [dynamicPapers]);

    // 9. Quiz Performance by Subject
    const quizPerformance = useMemo(() => {
        const performance = {};
        quizResults.forEach(quiz => {
            const subject = quiz.topic || 'General';
            if (!performance[subject]) {
                performance[subject] = { correct: 0, total: 0, attempts: 0 };
            }
            performance[subject].correct += quiz.score || 0;
            performance[subject].total += quiz.totalQuestions || 0;
            performance[subject].attempts += 1;
        });
        return Object.entries(performance).map(([subject, data]) => ({
            subject,
            accuracy: data.total > 0 ? Math.round((data.correct / data.total) * 100) : 0,
            attempts: data.attempts
        }));
    }, [quizResults]);

    // 10. Study Consistency Score
    const consistencyScore = useMemo(() => {
        const last30Days = [...Array(30)].map((_, i) => format(subDays(new Date(), i), 'yyyy-MM-dd'));
        const studyDays = new Set();
        logs.forEach(log => {
            if (log.date) {
                studyDays.add(format(parseISO(log.date), 'yyyy-MM-dd'));
            }
        });
        const activeDaysLast30 = last30Days.filter(d => studyDays.has(d)).length;
        return Math.round((activeDaysLast30 / 30) * 100);
    }, [logs]);

    const totalHours = filteredLogs.reduce((acc, curr) => acc + (curr.durationMinutes || 0) / 60, 0);
    const PIE_COLORS = ['#000000', '#333333', '#555555', '#777777', '#999999', '#BBBBBB'];

    const handleDownloadReport = () => {
        const doc = new jsPDF();
        doc.setFontSize(22);
        doc.text("UPSC Study Analytics Report", 20, 20);
        doc.setFontSize(12);
        doc.text(`Generated on: ${format(new Date(), 'PPpp')}`, 20, 30);
        doc.text(`Time Range: ${timeRange.toUpperCase()}`, 20, 36);
        doc.text(`Total Focus Time: ${totalHours.toFixed(1)} Hours`, 20, 50);
        doc.text(`Daily Average: ${dailyAverage} Hours`, 20, 56);
        doc.text(`Consistency Score: ${consistencyScore}%`, 20, 62);
        doc.text(`Current Streak: ${userStats?.currentStreak || 0} days`, 20, 68);

        // Paper Progress Table
        const tableData = paperHours.map(p => [p.name, `${p.hours}h`, `${syllabusProgress.find(s => s.id === p.id)?.progress || 0}%`]);
        doc.autoTable({
            startY: 80,
            head: [['Paper', 'Hours Studied', 'Syllabus Progress']],
            body: tableData,
            theme: 'grid',
            headStyles: { fillColor: [0, 0, 0] }
        });

        doc.save(`UPSC_Analytics_${format(new Date(), 'yyyy-MM-dd')}.pdf`);
    };

    // Custom tooltip
    const CustomTooltip = ({ active, payload, label }) => {
        if (active && payload && payload.length) {
            return (
                <div className="bg-white dark:bg-dark-surface border border-black/10 dark:border-white/10 rounded px-3 py-2 shadow-lg">
                    <p className="text-sm font-medium">{label}</p>
                    {payload.map((p, i) => (
                        <p key={i} className="text-sm text-[#71717A]">{p.name}: {p.value}</p>
                    ))}
                </div>
            );
        }
        return null;
    };

    return (
        <div className="space-y-8 animate-fade-in pb-12">
            {/* Header */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-medium">Comprehensive <span className="font-bold">Analytics</span></h1>
                    <p className="text-[#71717A] font-light">Complete insights into your UPSC preparation</p>
                </div>
                <motion.button
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    onClick={handleDownloadReport}
                    className="btn-primary px-6 py-2 rounded flex items-center gap-2 font-medium"
                >
                    <Download className="w-5 h-5" />
                    Download Report
                </motion.button>
            </div>

            {/* Tab Navigation */}
            <div className="flex gap-1 bg-black/5 dark:bg-white/5 p-1 rounded w-fit">
                {[
                    { id: 'overview', label: 'Overview', icon: Activity },
                    { id: 'papers', label: 'Papers', icon: FileText },
                    { id: 'trends', label: 'Trends', icon: TrendingUp },
                    { id: 'quiz', label: 'Quiz Stats', icon: Brain }
                ].map(tab => (
                    <button
                        key={tab.id}
                        onClick={() => setActiveTab(tab.id)}
                        className={`flex items-center gap-2 px-4 py-2 rounded text-sm font-medium transition-all ${activeTab === tab.id
                            ? 'bg-black text-white dark:bg-white dark:text-black'
                            : 'text-[#71717A] hover:text-black dark:hover:text-white'
                            }`}
                    >
                        <tab.icon className="w-4 h-4" />
                        {tab.label}
                    </button>
                ))}
            </div>

            {/* Time Range Filter */}
            <div className="card p-2 inline-flex flex-wrap gap-1">
                {['7d', '30d', '90d', 'year', 'all'].map((range) => (
                    <button
                        key={range}
                        onClick={() => setTimeRange(range)}
                        className={`px-4 py-2 rounded text-sm font-medium transition-all ${timeRange === range
                            ? 'bg-black text-white dark:bg-white dark:text-black'
                            : 'text-[#71717A] hover:text-black dark:hover:text-white'
                            }`}
                    >
                        {range === 'year' ? 'This Year' : range === 'all' ? 'All Time' : `Last ${range.replace('d', ' Days')}`}
                    </button>
                ))}
            </div>

            {/* Overview Tab */}
            <AnimatePresence mode="wait">
                {activeTab === 'overview' && (
                    <motion.div
                        key="overview"
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -20 }}
                        className="space-y-6"
                    >
                        {/* Key Metrics */}
                        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
                            {[
                                { label: 'Total Hours', value: totalHours.toFixed(1), unit: 'hrs', icon: Clock, color: 'from-blue-500' },
                                { label: 'Daily Average', value: dailyAverage, unit: 'hrs', icon: TrendingUp, color: 'from-green-500' },
                                { label: 'Current Streak', value: userStats?.currentStreak || 0, unit: 'days', icon: Flame, color: 'from-orange-500' },
                                { label: 'Consistency', value: consistencyScore, unit: '%', icon: Target, color: 'from-purple-500' },
                                { label: 'Sessions', value: filteredLogs.length, unit: '', icon: Zap, color: 'from-pink-500' }
                            ].map((metric, idx) => (
                                <motion.div
                                    key={metric.label}
                                    initial={{ opacity: 0, scale: 0.9 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    transition={{ delay: idx * 0.1 }}
                                    className="card p-4 relative overflow-hidden"
                                >
                                    <div className={`absolute inset-0 bg-gradient-to-br ${metric.color} to-transparent opacity-5`} />
                                    <div className="relative z-10">
                                        <metric.icon className="w-5 h-5 text-[#71717A] mb-2" />
                                        <p className="text-3xl font-bold">{metric.value}<span className="text-lg text-[#71717A] ml-1">{metric.unit}</span></p>
                                        <p className="text-sm text-[#71717A] font-light">{metric.label}</p>
                                    </div>
                                </motion.div>
                            ))}
                        </div>

                        {/* Weekly Comparison */}
                        <div className="card p-6">
                            <h3 className="text-lg font-medium mb-4">Weekly <span className="font-bold">Comparison</span></h3>
                            <div className="grid grid-cols-3 gap-4">
                                <div className="text-center p-4 bg-[#FAFAFA] dark:bg-dark-surface rounded">
                                    <p className="text-sm text-[#71717A] mb-1">This Week</p>
                                    <p className="text-3xl font-bold">{weeklyComparison.thisWeek}h</p>
                                </div>
                                <div className="text-center p-4 bg-[#FAFAFA] dark:bg-dark-surface rounded">
                                    <p className="text-sm text-[#71717A] mb-1">Last Week</p>
                                    <p className="text-3xl font-bold">{weeklyComparison.lastWeek}h</p>
                                </div>
                                <div className="text-center p-4 bg-[#FAFAFA] dark:bg-dark-surface rounded">
                                    <p className="text-sm text-[#71717A] mb-1">Change</p>
                                    <p className={`text-3xl font-bold flex items-center justify-center gap-1 ${weeklyComparison.change >= 0 ? 'text-green-600' : 'text-red-600'
                                        }`}>
                                        {weeklyComparison.change >= 0 ? <ArrowUp className="w-5 h-5" /> : <ArrowDown className="w-5 h-5" />}
                                        {Math.abs(weeklyComparison.change)}%
                                    </p>
                                </div>
                            </div>
                        </div>

                        {/* Charts Grid */}
                        <div className="grid lg:grid-cols-2 gap-6">
                            {/* Study Trend */}
                            <div className="card p-6">
                                <h3 className="text-lg font-medium mb-4">Study <span className="font-bold">Trend</span></h3>
                                <div className="h-64">
                                    <ResponsiveContainer width="100%" height="100%">
                                        <AreaChart data={trendData}>
                                            <defs>
                                                <linearGradient id="colorHoursGrad" x1="0" y1="0" x2="0" y2="1">
                                                    <stop offset="5%" stopColor="#000" stopOpacity={0.3} />
                                                    <stop offset="95%" stopColor="#000" stopOpacity={0} />
                                                </linearGradient>
                                            </defs>
                                            <CartesianGrid strokeDasharray="3 3" stroke="#e5e5e5" />
                                            <XAxis dataKey="date" stroke="#71717A" fontSize={10} />
                                            <YAxis stroke="#71717A" fontSize={12} unit="h" />
                                            <Tooltip content={<CustomTooltip />} />
                                            <Area type="monotone" dataKey="hours" stroke="#000" strokeWidth={2} fill="url(#colorHoursGrad)" name="Hours" />
                                        </AreaChart>
                                    </ResponsiveContainer>
                                </div>
                            </div>

                            {/* Subject Distribution */}
                            <div className="card p-6">
                                <h3 className="text-lg font-medium mb-4">Subject <span className="font-bold">Distribution</span></h3>
                                <div className="h-64">
                                    {subjectData.length > 0 ? (
                                        <ResponsiveContainer width="100%" height="100%">
                                            <PieChart>
                                                <Pie
                                                    data={subjectData.slice(0, 6)}
                                                    cx="50%"
                                                    cy="50%"
                                                    innerRadius={50}
                                                    outerRadius={80}
                                                    dataKey="hours"
                                                    label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                                                    labelLine={false}
                                                >
                                                    {subjectData.slice(0, 6).map((_, index) => (
                                                        <Cell key={index} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                                                    ))}
                                                </Pie>
                                                <Tooltip content={<CustomTooltip />} />
                                            </PieChart>
                                        </ResponsiveContainer>
                                    ) : (
                                        <div className="h-full flex items-center justify-center text-[#71717A]">
                                            <p className="font-light">No data yet</p>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    </motion.div>
                )}

                {/* Papers Tab */}
                {activeTab === 'papers' && (
                    <motion.div
                        key="papers"
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -20 }}
                        className="space-y-6"
                    >
                        {/* Paper Progress Overview */}
                        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
                            {syllabusProgress.map((paper, idx) => (
                                <motion.div
                                    key={paper.id}
                                    initial={{ opacity: 0, y: 20 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ delay: idx * 0.1 }}
                                    className="card p-6"
                                >
                                    <div className="flex items-center gap-3 mb-4">
                                        <div className="w-10 h-10 rounded flex items-center justify-center" style={{ backgroundColor: paper.color + '20' }}>
                                            <FileText className="w-5 h-5" style={{ color: paper.color }} />
                                        </div>
                                        <div>
                                            <h4 className="font-bold">{paper.short}</h4>
                                            <p className="text-xs text-[#71717A]">{paper.name}</p>
                                        </div>
                                    </div>

                                    <div className="space-y-2">
                                        <div className="flex justify-between text-sm">
                                            <span className="text-[#71717A]">Progress</span>
                                            <span className="font-bold">{paper.progress}%</span>
                                        </div>
                                        <div className="h-2 bg-black/5 dark:bg-white/10 rounded-full overflow-hidden">
                                            <motion.div
                                                initial={{ width: 0 }}
                                                animate={{ width: `${paper.progress}%` }}
                                                transition={{ duration: 1, delay: idx * 0.1 }}
                                                className="h-full rounded-full"
                                                style={{ backgroundColor: paper.color }}
                                            />
                                        </div>
                                        <div className="flex justify-between text-xs text-[#71717A]">
                                            <span>{paper.completed} completed</span>
                                            <span>{paper.total} topics</span>
                                        </div>
                                    </div>

                                    <div className="mt-4 pt-4 border-t border-black/5 dark:border-white/5">
                                        <div className="flex justify-between text-sm">
                                            <span className="text-[#71717A]">Hours Studied</span>
                                            <span className="font-bold">{paperHours.find(p => p.id === paper.id)?.hours || 0}h</span>
                                        </div>
                                    </div>
                                </motion.div>
                            ))}
                        </div>

                        {/* Paper Hours Chart */}
                        <div className="card p-6">
                            <h3 className="text-lg font-medium mb-4">Hours by <span className="font-bold">Paper</span></h3>
                            <div className="h-72">
                                <ResponsiveContainer width="100%" height="100%">
                                    <BarChart data={paperHours} layout="vertical">
                                        <CartesianGrid strokeDasharray="3 3" stroke="#e5e5e5" horizontal={false} />
                                        <XAxis type="number" stroke="#71717A" fontSize={12} unit="h" />
                                        <YAxis type="category" dataKey="short" stroke="#71717A" fontSize={12} width={60} />
                                        <Tooltip content={<CustomTooltip />} />
                                        <Bar dataKey="hours" radius={[0, 4, 4, 0]} barSize={30}>
                                            {paperHours.map((entry, index) => (
                                                <Cell key={index} fill={entry.color} />
                                            ))}
                                        </Bar>
                                    </BarChart>
                                </ResponsiveContainer>
                            </div>
                        </div>
                    </motion.div>
                )}

                {/* Trends Tab */}
                {activeTab === 'trends' && (
                    <motion.div
                        key="trends"
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -20 }}
                        className="space-y-6"
                    >
                        {/* Peak Study Hours */}
                        <div className="card p-6">
                            <h3 className="text-lg font-medium mb-4">Peak <span className="font-bold">Study Hours</span></h3>
                            <div className="grid grid-cols-5 gap-4">
                                {peakHours.map((peak, idx) => (
                                    <motion.div
                                        key={peak.hour}
                                        initial={{ opacity: 0, scale: 0.9 }}
                                        animate={{ opacity: 1, scale: 1 }}
                                        transition={{ delay: idx * 0.1 }}
                                        className="text-center p-4 bg-[#FAFAFA] dark:bg-dark-surface rounded"
                                    >
                                        <p className="text-xs text-[#71717A] mb-1">#{idx + 1}</p>
                                        <p className="text-xl font-bold">{peak.hour}</p>
                                        <p className="text-sm text-[#71717A]">{peak.hours}h total</p>
                                    </motion.div>
                                ))}
                            </div>
                        </div>

                        {/* Mode Distribution */}
                        <div className="card p-6">
                            <h3 className="text-lg font-medium mb-4">Session <span className="font-bold">Modes</span></h3>
                            <div className="grid grid-cols-3 gap-4">
                                {modeDistribution.map((mode, idx) => (
                                    <motion.div
                                        key={mode.name}
                                        initial={{ opacity: 0, y: 20 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        transition={{ delay: idx * 0.1 }}
                                        className="text-center p-6 bg-[#FAFAFA] dark:bg-dark-surface rounded"
                                    >
                                        <p className="text-4xl font-bold">{mode.value}</p>
                                        <p className="text-sm text-[#71717A] mt-1">{mode.name}</p>
                                    </motion.div>
                                ))}
                            </div>
                        </div>
                    </motion.div>
                )}

                {/* Quiz Stats Tab */}
                {activeTab === 'quiz' && (
                    <motion.div
                        key="quiz"
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -20 }}
                        className="space-y-6"
                    >
                        <div className="grid lg:grid-cols-2 gap-6">
                            <div className="card p-6">
                                <h3 className="text-lg font-medium mb-4">Quiz <span className="font-bold">Overview</span></h3>
                                <div className="grid grid-cols-2 gap-4">
                                    <div className="p-4 bg-[#FAFAFA] dark:bg-dark-surface rounded text-center">
                                        <p className="text-3xl font-bold">{quizResults.length}</p>
                                        <p className="text-sm text-[#71717A]">Total Quizzes</p>
                                    </div>
                                    <div className="p-4 bg-[#FAFAFA] dark:bg-dark-surface rounded text-center">
                                        <p className="text-3xl font-bold">
                                            {quizResults.length > 0
                                                ? Math.round(quizResults.reduce((acc, q) => acc + (q.score / q.totalQuestions) * 100, 0) / quizResults.length)
                                                : 0}%
                                        </p>
                                        <p className="text-sm text-[#71717A]">Avg Accuracy</p>
                                    </div>
                                </div>
                            </div>

                            <div className="card p-6">
                                <h3 className="text-lg font-medium mb-4">Performance by <span className="font-bold">Topic</span></h3>
                                <div className="space-y-3 max-h-48 overflow-y-auto">
                                    {quizPerformance.map((perf, idx) => (
                                        <div key={perf.subject} className="flex items-center justify-between">
                                            <span className="text-sm truncate flex-1">{perf.subject}</span>
                                            <div className="flex items-center gap-2">
                                                <div className="w-20 h-2 bg-black/5 dark:bg-white/10 rounded-full overflow-hidden">
                                                    <div
                                                        className="h-full bg-black dark:bg-white rounded-full"
                                                        style={{ width: `${perf.accuracy}%` }}
                                                    />
                                                </div>
                                                <span className="text-sm font-bold w-12 text-right">{perf.accuracy}%</span>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
